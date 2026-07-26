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
import {
	FUZZY_DASHBOARD_CACHE_READ_MESSAGE,
	isDashboardCacheReadRequestMessage,
} from "../../apps/extension/src/lib/cache/dashboardCacheMessaging";

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

		expect(
			hasValidFuzzyApiRequestPayload({
				type: FUZZY_API_MESSAGE_TYPE,
				method: "search",
				request: { query: "正規化" },
			}),
		).toBe(true);
		expect(
			hasValidFuzzyApiRequestPayload({
				type: FUZZY_API_MESSAGE_TYPE,
				method: "search",
				request: { query: "検".repeat(257) },
			}),
		).toBe(false);
		expect(
			hasValidFuzzyApiRequestPayload({
				type: FUZZY_API_MESSAGE_TYPE,
				method: "updateSubmissionStatus",
				request: { assignmentId: -1, submitted: true },
			}),
		).toBe(false);
		expect(
			hasValidFuzzyApiRequestPayload({
				type: FUZZY_API_MESSAGE_TYPE,
				method: "rebuildLibrary",
				request: {},
			}),
		).toBe(true);
		expect(
			hasValidFuzzyApiRequestPayload({
				type: FUZZY_API_MESSAGE_TYPE,
				method: "rebuildLibrary",
				request: { rebuildIndex: true },
			}),
		).toBe(true);
		for (const request of [
			{ rebuildIndex: null },
			{ rebuildIndex: "yes" },
			{ rebuildIndex: false, unexpected: true },
		]) {
			expect(
				hasValidFuzzyApiRequestPayload({
					type: FUZZY_API_MESSAGE_TYPE,
					method: "rebuildLibrary",
					request,
				}),
			).toBe(false);
		}

		const validSync: FuzzyApiRequestMessage = {
			type: FUZZY_API_MESSAGE_TYPE,
			method: "syncMoodleAssignments",
			request: {
				trigger: "auto",
				course: {
					moodleCourseId: "412",
					name: "データベース",
					academicYear: 2026,
					term: "2026前期",
				},
				assignments: [
					{
						moodleAssignmentId: "assign:701",
						title: "正規化レポート",
						dueAt: "2026-07-30T23:59:00+09:00",
						source: "moodle_text",
						dueAtStatus: "normal",
						submissionMode: "moodle_auto",
						submitted: false,
					},
				],
			},
		};
		expect(hasValidFuzzyApiRequestPayload(validSync)).toBe(true);
		expect(
			hasValidFuzzyApiRequestPayload({
				...validSync,
				request: {
					...(validSync.request as Record<string, unknown>),
					assignments: [
						{
							moodleAssignmentId: "",
							title: "不安定な課題",
							dueAt: "2026-07-30T23:59:00",
							source: "moodle_text",
							dueAtStatus: "normal",
							submissionMode: "moodle_auto",
							submitted: false,
						},
					],
				},
			}),
		).toBe(false);
	});

	test("検索・ダッシュボード・締切・同期履歴も同じbackground境界で中継する", async () => {
		const calls: string[] = [];
		const notifiedSyncEventIds: number[] = [];
		const client = {
			mode: "native",
			getDashboard: async () => {
				calls.push("getDashboard");
				return { courses: [], totalFiles: 0, totalViolations: 0, upcomingDeadlineCount: 0 };
			},
			getDeadlines: async () => {
				calls.push("getDeadlines");
				return [];
			},
			search: async () => {
				calls.push("search");
				return [];
			},
			getLatestSyncEvent: async () => {
				calls.push("getLatestSyncEvent");
				return null;
			},
			syncMoodleAssignments: async () => {
				calls.push("syncMoodleAssignments");
				return {
					id: 1,
					syncedAt: "2026-07-25T00:00:00Z",
					trigger: "auto",
					newAssignmentCount: 0,
					changedAssignmentCount: 0,
					removedAssignmentCount: 0,
				};
			},
			getAssignmentChanges: async () => {
				calls.push("getAssignmentChanges");
				return [];
			},
		} as unknown as FuzzyApiClient;

		for (const message of [
			{ method: "getDashboard", request: {} },
			{ method: "getDeadlines", request: { includePast: true } },
			{ method: "search", request: { query: "正規化" } },
			{
				method: "syncMoodleAssignments",
				request: {
					trigger: "auto",
					course: {
						moodleCourseId: "412",
						name: "データベース",
						academicYear: 2026,
						term: "2026前期",
					},
					assignments: [],
				},
			},
			{ method: "getLatestSyncEvent", request: {} },
			{ method: "getAssignmentChanges", request: {} },
		] as const) {
			await callBackgroundApi(
				client,
				{
					type: FUZZY_API_MESSAGE_TYPE,
					method: message.method,
					request: message.request,
				},
				{
					notifySyncEvent: async (event) => {
						notifiedSyncEventIds.push(event.id);
					},
				},
			);
		}

		expect(calls).toEqual([
			"getDashboard",
			"getDeadlines",
			"search",
			"syncMoodleAssignments",
			"getLatestSyncEvent",
			"getAssignmentChanges",
		]);
		expect(notifiedSyncEventIds).toEqual([1]);
	});

	test("同期通知に失敗してもcommit済みeventをAPI成功として返す", async () => {
		const event = {
			id: 9,
			syncedAt: "2026-07-25T00:00:00Z",
			trigger: "auto" as const,
			newAssignmentCount: 1,
			changedAssignmentCount: 0,
			removedAssignmentCount: 0,
		};
		const notificationErrors: unknown[] = [];
		const client = {
			mode: "native",
			syncMoodleAssignments: async () => event,
		} as unknown as FuzzyApiClient;

		await expect(
			callBackgroundApi(
				client,
				{
					type: FUZZY_API_MESSAGE_TYPE,
					method: "syncMoodleAssignments",
					request: {
						trigger: "auto",
						course: { moodleCourseId: "412", name: "データベース" },
						assignments: [],
					},
				},
				{
					notifySyncEvent: async () => {
						throw new Error("notifications permission denied");
					},
					onSyncNotificationError: (error) => notificationErrors.push(error),
				},
			),
		).resolves.toEqual(event);
		expect(notificationErrors).toHaveLength(1);
	});

	test("nativeのダッシュボード成功時だけbackground側のキャッシュへ保存する", async () => {
		const dashboard = {
			courses: [],
			totalFiles: 4,
			totalViolations: 0,
			upcomingDeadlineCount: 1,
		};
		const cached: unknown[] = [];
		const message: FuzzyApiRequestMessage = {
			type: FUZZY_API_MESSAGE_TYPE,
			method: "getDashboard",
			request: {},
		};
		const createClient = (mode: FuzzyApiClient["mode"]) =>
			({
				mode,
				getDashboard: async () => dashboard,
			}) as unknown as FuzzyApiClient;

		await callBackgroundApi(createClient("native"), message, {
			writeDashboardCache: async (value) => {
				cached.push(value);
			},
		});
		await callBackgroundApi(createClient("mock"), message, {
			writeDashboardCache: async (value) => {
				cached.push(value);
			},
		});

		expect(cached).toEqual([dashboard]);
	});

	test("ライブラリ再構築要求と集計をnative clientへそのまま中継する", async () => {
		const summary = {
			scannedFileCount: 6,
			registeredFileCount: 2,
			updatedFileCount: 1,
			indexedFileCount: 5,
			missingFileCount: 0,
			skippedFileCount: 1,
			warnings: [],
		};
		let captured: unknown = null;
		const client = {
			mode: "native",
			rebuildLibrary: async (request: unknown) => {
				captured = request;
				return summary;
			},
		} as unknown as FuzzyApiClient;
		const message: FuzzyApiRequestMessage = {
			type: FUZZY_API_MESSAGE_TYPE,
			method: "rebuildLibrary",
			request: { rebuildIndex: true },
		};

		await expect(callBackgroundApi(client, message)).resolves.toEqual(summary);
		expect(captured).toEqual({ rebuildIndex: true });
	});

	test("content script用キャッシュ読取メッセージを厳密に識別する", () => {
		expect(isDashboardCacheReadRequestMessage({ type: FUZZY_DASHBOARD_CACHE_READ_MESSAGE })).toBe(
			true,
		);
		expect(isDashboardCacheReadRequestMessage({ type: "fuzzy:other" })).toBe(false);
		expect(isDashboardCacheReadRequestMessage(null)).toBe(false);
	});
});
