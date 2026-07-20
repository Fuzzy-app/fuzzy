import { describe, expect, test } from "bun:test";
import type { MoodleFileLink } from "../../apps/extension/src/lib/moodle/pageSnapshot";
import { resolveMissingMimeHints } from "../../apps/extension/src/lib/moodle/snapshotCollector";

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
		const cache = new Map<string, Promise<string | null>>();
		const files = [1, 2, 3, 4].map((id) => createFile(id));
		const options = { fetcher, origin: ORIGIN, maxRequests: 3, concurrency: 2, cache };

		const first = await resolveMissingMimeHints(files, options);
		const second = await resolveMissingMimeHints(files, options);

		expect(first.map((file) => file.mimeHint)).toEqual(["pdf", "pdf", "pdf", null]);
		expect(second.map((file) => file.mimeHint)).toEqual(["pdf", "pdf", "pdf", null]);
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
		expect(unknown[0]?.mimeHint).toBeNull();
	});

	test("タイムアウト時は資料一覧を壊さず、外部オリジンへは送信しない", async () => {
		let requestCount = 0;
		const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) => {
			requestCount += 1;
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		}) as typeof fetch;
		const sameOrigin = createFile(1);
		const external = { ...createFile(2), url: "https://outside.example/file" };

		const result = await resolveMissingMimeHints([sameOrigin, external], {
			fetcher,
			origin: ORIGIN,
			timeoutMs: 5,
			cache: new Map(),
		});

		expect(result).toEqual([sameOrigin, external]);
		expect(requestCount).toBe(1);
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
