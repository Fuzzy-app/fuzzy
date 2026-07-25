import { describe, expect, test } from "bun:test";
import type { FuzzyApiClient, SaveFilesRequest } from "@fuzzy/shared";
import {
	checkMoodleFileFromBackground,
	saveMoodleFilesFromBackground,
} from "../../apps/extension/src/lib/api/backgroundFileSave";

describe("Moodle資料保存のbackground境界", () => {
	test("取得成功分だけをnative clientへ渡し、失敗分を結果へ残す", async () => {
		let capturedFileIds: string[] = [];
		const client = {
			mode: "native" as const,
			async saveFiles(request: SaveFilesRequest) {
				capturedFileIds = request.files.map((file) => file.fileId);
				return { savedFileIds: request.files.map((file) => file.fileId), failedFiles: [] };
			},
		} as Pick<FuzzyApiClient, "mode" | "saveFiles">;
		const response = await saveMoodleFilesFromBackground(
			client,
			{
				targetPath: "C:\\save",
				courseId: 2,
				files: [
					createFile("1", "https://moodle.example/mod/resource/view.php?id=1"),
					createFile("2", "https://outside.example/mod/resource/view.php?id=2"),
				],
			},
			"https://moodle.example",
			{
				fetcher: (async () =>
					new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
						status: 200,
						headers: {
							"content-type":
								"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
						},
					})) as unknown as typeof fetch,
			},
		);

		expect(capturedFileIds).toEqual(["1"]);
		expect(response).toEqual({
			savedFileIds: ["1"],
			failedFiles: [{ fileId: "2", code: "DOWNLOAD_FAILED" }],
		});
	});

	test("mockではネットワーク取得を行わず従来どおり成功結果を返す", async () => {
		let fetched = false;
		const client = {
			mode: "mock" as const,
			async saveFiles(request: SaveFilesRequest) {
				return { savedFileIds: request.files.map((file) => file.fileId), failedFiles: [] };
			},
		} as Pick<FuzzyApiClient, "mode" | "saveFiles">;
		const response = await saveMoodleFilesFromBackground(
			client,
			{
				targetPath: "C:\\save",
				courseId: 2,
				files: [createFile("1", "https://moodle.example/file.docx")],
			},
			"https://moodle.example",
			{
				fetcher: (async () => {
					fetched = true;
					return new Response();
				}) as unknown as typeof fetch,
			},
		);

		expect(fetched).toBe(false);
		expect(response.failedFiles).toEqual([]);
		expect(response.savedFileIds).toEqual(["1"]);
	});

	test("downloads file content before asking the native host for similar files", async () => {
		let capturedContent: string | undefined;
		const client = {
			mode: "native" as const,
			async checkSimilarFiles(request: { contentBase64?: string }) {
				capturedContent = request.contentBase64;
				return [];
			},
		} as unknown as Pick<FuzzyApiClient, "mode" | "checkSimilarFiles">;

		await checkMoodleFileFromBackground(
			client,
			{ fileMeta: createFile("1", "https://moodle.example/file.pdf") },
			"https://moodle.example",
			{
				fetcher: (async () =>
					new Response(new Uint8Array([1, 2, 3, 4]), {
						status: 200,
						headers: { "content-type": "application/pdf" },
					})) as unknown as typeof fetch,
			},
		);

		expect(capturedContent).toBe("AQIDBA==");
	});
});

function createFile(id: string, url: string) {
	return {
		title: `資料${id}.docx`,
		url,
		moodleFileId: id,
		sectionTitle: null,
		mimeHint: "docx",
	};
}
