import { describe, expect, test } from "bun:test";
import type { MoodleFileLink } from "../../apps/extension/src/lib/moodle/pageSnapshot";
import {
	type ResolvedMoodleFileMetadata,
	resolveMissingMimeHints,
} from "../../apps/extension/src/lib/moodle/snapshotCollector";

const ORIGIN = "https://moodle.example";

describe("未判定MIMEのHEAD補完", () => {
	test("同時実行数とリクエスト上限を守り、同一URLはキャッシュする", async () => {
		let activeRequests = 0;
		let maxActiveRequests = 0;
		let requestCount = 0;
		const fetcher = (async () => {
			requestCount += 1;
			activeRequests += 1;
			maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
			await new Promise((resolve) => setTimeout(resolve, 5));
			activeRequests -= 1;
			return new Response(null, { status: 200, headers: { "content-type": "application/pdf" } });
		}) as unknown as typeof fetch;
		const cache = new Map<string, Promise<ResolvedMoodleFileMetadata | null>>();
		const files = [1, 2, 3, 4].map((id) => createFile(id));
		const options = { fetcher, origin: ORIGIN, maxRequests: 3, concurrency: 2, cache };

		const first = await resolveMissingMimeHints(files, options);
		const second = await resolveMissingMimeHints(files, options);

		expect(first.map((file) => file.mimeHint)).toEqual(["pdf", "pdf", "pdf"]);
		expect(second.map((file) => file.mimeHint)).toEqual(["pdf", "pdf", "pdf"]);
		expect(requestCount).toBe(3);
		expect(maxActiveRequests).toBeLessThanOrEqual(2);
	});

	test("Content-Dispositionを補助根拠に使い、未対応拡張子は採用しない", async () => {
		const dispositionFetcher = (async () =>
			new Response(null, {
				status: 200,
				headers: {
					"content-type": "application/octet-stream",
					"content-disposition": "attachment; filename*=UTF-8''lecture%20notes.pptx",
				},
			})) as unknown as typeof fetch;
		const unknownFetcher = (async () =>
			new Response(null, {
				status: 200,
				headers: { "content-disposition": 'attachment; filename="payload.bin"' },
			})) as unknown as typeof fetch;

		const detected = await resolveMissingMimeHints([createFile(1)], {
			fetcher: dispositionFetcher,
			origin: ORIGIN,
			cache: new Map(),
		});
		const unknown = await resolveMissingMimeHints([createFile(2)], {
			fetcher: unknownFetcher,
			origin: ORIGIN,
			cache: new Map(),
		});

		expect(detected[0]?.mimeHint).toBe("pptx");
		expect(unknown).toEqual([]);
	});

	test("HEADで判定できない場合はGETへフォールバックし、DOCXの実ファイル名を反映する", async () => {
		const methods: string[] = [];
		const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			methods.push(init?.method ?? "GET");
			if (init?.method === "HEAD") return new Response(null, { status: 405 });
			return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
				status: 200,
				headers: {
					"content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
					"content-disposition": "attachment; filename*=UTF-8''guidance%20notes.docx",
				},
			});
		}) as typeof fetch;

		const result = await resolveMissingMimeHints([createFile(1)], {
			fetcher,
			origin: ORIGIN,
			cache: new Map(),
		});

		expect(methods).toEqual(["HEAD", "GET"]);
		expect(result[0]).toMatchObject({
			title: "guidance notes.docx",
			mimeHint: "docx",
		});
	});

	test("PDFアイコンで種類が判明済みでもMoodle資料ページを実体URLへ解決する", async () => {
		const finalUrl = `${ORIGIN}/pluginfile.php/42/mod_resource/content/1/lecture.pdf`;
		const fetcher = (async () => {
			const response = new Response(null, {
				status: 200,
				headers: {
					"content-type": "application/pdf",
					"content-disposition": 'attachment; filename="lecture.pdf"',
				},
			});
			Object.defineProperty(response, "url", { value: finalUrl });
			return response;
		}) as unknown as typeof fetch;
		const file = { ...createFile(1), mimeHint: "pdf" };

		const result = await resolveMissingMimeHints([file], {
			fetcher,
			origin: ORIGIN,
			cache: new Map(),
		});

		expect(result).toEqual([
			{
				...file,
				title: "lecture.pdf",
				url: finalUrl,
			},
		]);
	});

	test("HEADがHTMLでもGETでPDFへ遷移する資料は保存候補に残す", async () => {
		const methods: string[] = [];
		const finalUrl = `${ORIGIN}/pluginfile.php/42/mod_resource/content/1/lecture.pdf`;
		const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			methods.push(init?.method ?? "GET");
			if (init?.method === "HEAD") {
				return new Response(null, {
					status: 200,
					headers: { "content-type": "text/html" },
				});
			}
			const response = new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
				status: 200,
				headers: { "content-type": "application/pdf" },
			});
			Object.defineProperty(response, "url", { value: finalUrl });
			return response;
		}) as typeof fetch;

		const result = await resolveMissingMimeHints([{ ...createFile(1), mimeHint: "pdf" }], {
			fetcher,
			origin: ORIGIN,
			cache: new Map(),
		});

		expect(methods).toEqual(["HEAD", "GET"]);
		expect(result[0]).toMatchObject({ url: finalUrl, mimeHint: "pdf" });
	});

	test("HTML応答は資料候補から除外する", async () => {
		const fetcher = (async () =>
			new Response("<!doctype html><title>login</title>", {
				status: 200,
				headers: { "content-type": "text/html" },
			})) as unknown as typeof fetch;

		expect(
			await resolveMissingMimeHints([createFile(1)], {
				fetcher,
				origin: ORIGIN,
				cache: new Map(),
			}),
		).toEqual([]);
	});

	test("タイムアウトを固定化せず再試行でき、外部オリジンへは送信しない", async () => {
		let requestCount = 0;
		let fail = true;
		const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) => {
			requestCount += 1;
			if (!fail) {
				return Promise.resolve(
					new Response(null, {
						status: 200,
						headers: { "content-type": "application/pdf" },
					}),
				);
			}
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		}) as typeof fetch;
		const sameOrigin = createFile(1);
		const external = { ...createFile(2), url: "https://outside.example/file" };

		const options = {
			fetcher,
			origin: ORIGIN,
			timeoutMs: 5,
			cache: new Map(),
		};
		const first = await resolveMissingMimeHints([sameOrigin, external], options);
		fail = false;
		const second = await resolveMissingMimeHints([sameOrigin, external], options);

		expect(first).toEqual([external]);
		expect(second).toEqual([{ ...sameOrigin, title: "資料1.pdf", mimeHint: "pdf" }, external]);
		expect(requestCount).toBe(3);
	});
});

function createFile(id: number): MoodleFileLink {
	return {
		title: `資料${id}`,
		url: `${ORIGIN}/mod/resource/view.php?id=${id}`,
		moodleFileId: String(id),
		sectionTitle: `第${id}回`,
		mimeHint: null,
	};
}
