import { describe, expect, test } from "bun:test";
import { ApiError, type FuzzyApiClient } from "@fuzzy/shared";
import {
	FUZZY_API_MESSAGE_TYPE,
	type FuzzyApiRequestMessage,
	hasValidFuzzyApiRequestPayload,
	isFuzzyApiRequestMessage,
	toBackgroundApiError,
} from "../../apps/extension/src/lib/api/backgroundApi";
import { callBackgroundApi } from "../../apps/extension/src/lib/api/backgroundDispatch";

describe("コースフォルダ名のbackground API中継", () => {
	test("updateCourseFolderNameのrequestとresponseをそのまま中継する", async () => {
		let captured: unknown = null;
		const result = {
			ok: true as const,
			courseFolder: { courseId: 2, folderName: "英語_A", warnings: [] },
		};
		const client = {
			async updateCourseFolderName(request: unknown) {
				captured = request;
				return result;
			},
		} as unknown as FuzzyApiClient;
		const message: FuzzyApiRequestMessage = {
			type: FUZZY_API_MESSAGE_TYPE,
			method: "updateCourseFolderName" as const,
			request: { courseId: 2, folderName: "英語_A" },
		};

		expect(isFuzzyApiRequestMessage(message)).toBe(true);
		expect(await callBackgroundApi(client, message)).toEqual(result);
		expect(captured).toEqual({ courseId: 2, folderName: "英語_A" });
	});

	test("ApiErrorのcodeをruntimeメッセージ境界でも保持する", () => {
		expect(toBackgroundApiError(new ApiError("RULE_CONFLICT", "同名です"))).toEqual({
			code: "RULE_CONFLICT",
			message: "同名です",
		});
		expect(toBackgroundApiError(new Error("C:\\secret\\db.sqlite"))).toEqual({
			code: "INTERNAL",
			message: "APIの呼び出しに失敗しました",
		});
	});

	test("runtimeメソッドごとのpayloadをdispatch前に検証する", () => {
		const invalidSave: FuzzyApiRequestMessage = {
			type: FUZZY_API_MESSAGE_TYPE,
			method: "saveFiles",
			request: {
				targetPath: "C:\\save",
				courseId: 2,
				files: [{ title: "guide.pdf" }],
			},
		};
		expect(isFuzzyApiRequestMessage(invalidSave)).toBe(true);
		expect(hasValidFuzzyApiRequestPayload(invalidSave)).toBe(false);

		const courseOnlySuggestion: FuzzyApiRequestMessage = {
			type: FUZZY_API_MESSAGE_TYPE,
			method: "suggestSavePath",
			request: {
				course: {
					moodleCourseId: "course-412",
					name: "Data Science",
					academicYear: 2026,
					term: null,
					sectionTitle: null,
					breadcrumbs: [],
				},
			},
		};
		expect(hasValidFuzzyApiRequestPayload(courseOnlySuggestion)).toBe(true);
	});
});
