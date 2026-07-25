import { describe, expect, test } from "bun:test";
import {
	downloadMoodleFiles,
	transferFileId,
} from "../../apps/extension/src/lib/moodle/fileDownloader";

const ORIGIN = "https://moodle.example";

describe("Moodle資料本体の取得", () => {
	test("同一オリジンのDOCXを認証付きで取得し、Cookieを含めず内容だけを返す", async () => {
		const calls: RequestInit[] = [];
		const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			calls.push(init ?? {});
			return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01]), {
				status: 200,
				headers: {
					"content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
					"content-disposition":
						"attachment; filename*=UTF-8''%E3%82%AC%E3%82%A4%E3%83%80%E3%83%B3%E3%82%B9%E8%B3%87%E6%96%99.docx",
				},
			});
		}) as typeof fetch;

		const result = await downloadMoodleFiles(createRequest(), ORIGIN, { fetcher });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.credentials).toBe("include");
		expect(result.failedFiles).toEqual([]);
		expect(result.request.files[0]).toEqual({
			fileId: "4376",
			fileName: "ガイダンス資料.docx",
			mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			byteLength: 5,
			contentBase64: "UEsDBAE=",
		});
		expect(JSON.stringify(result)).not.toContain("cookie");
	});

	test("HTML・壊れたDOCX・外部オリジンを保存payloadへ入れない", async () => {
		let requestCount = 0;
		const htmlFetcher = (async () => {
			requestCount += 1;
			return new Response("<!doctype html><title>login</title>", {
				status: 200,
				headers: { "content-type": "text/html" },
			});
		}) as unknown as typeof fetch;
		const [original] = createRequest().files;
		if (!original) throw new Error("テスト資料がありません");
		const external = {
			...original,
			url: "https://outside.example/mod/resource/view.php?id=4376",
		};
		const result = await downloadMoodleFiles(
			{ ...createRequest(), files: [original, external] },
			ORIGIN,
			{ fetcher: htmlFetcher },
		);

		expect(result.request.files).toEqual([]);
		expect(result.failedFiles).toHaveLength(2);
		expect(requestCount).toBe(1);
	});

	test("一時的なHTTPエラーは一度だけ再試行する", async () => {
		let requestCount = 0;
		const fetcher = (async () => {
			requestCount += 1;
			if (requestCount === 1) return new Response(null, { status: 503 });
			return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
				status: 200,
				headers: {
					"content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				},
			});
		}) as unknown as typeof fetch;

		const result = await downloadMoodleFiles(createRequest(), ORIGIN, { fetcher });
		expect(requestCount).toBe(2);
		expect(result.request.files).toHaveLength(1);
	});

	test("Moodle IDがない資料はURLを転送IDとして使う", () => {
		const [original] = createRequest().files;
		if (!original) throw new Error("テスト資料がありません");
		const file = { ...original, moodleFileId: null };
		expect(transferFileId(file)).toBe(file.url);
	});
});

function createRequest() {
	return {
		targetPath: "C:\\Users\\sample\\Documents\\大学\\2026前期\\データベース",
		files: [
			{
				title: "ガイダンス資料.docx",
				url: `${ORIGIN}/mod/resource/view.php?id=4376`,
				moodleFileId: "4376",
				sectionTitle: null,
				mimeHint: "docx",
			},
		],
	};
}
