import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
	ASSIGNMENT_DETAIL_LIMITS,
	analyzeAssignmentSubmissionAvailability,
	collectAssignmentSubmissionAvailability,
	normalizeMoodleAssignmentDetailUrl,
} from "../../apps/extension/src/lib/moodle/assignmentDetail";
import type { MoodleAssignmentHint } from "../../apps/extension/src/lib/moodle/pageSnapshot";

const BASE_URL = "https://moodle2026.wakayama-u.ac.jp/course/view.php?id=412";
const DETAIL_URL = "https://moodle2026.wakayama-u.ac.jp/mod/assign/view.php?id=701";

describe("Moodle課題詳細の提出可否", () => {
	test("期限切れ表示があっても有効な提出開始操作をavailableにする", () => {
		const { document } = parseHTML(`
			<html><body class="loggedin">
				<main>
					<p>提出期限は過ぎています。</p>
					<form method="post" action="/mod/assign/view.php?id=701">
						<button type="submit" id="single_button6a66f2384213f6">
							提出をアップロード・入力する
						</button>
					</form>
				</main>
			</body></html>
		`);
		expect(analyzeAssignmentSubmissionAvailability(document, DETAIL_URL)).toBe("available");
	});

	test("disabledと受付終了の根拠をunavailableにする", () => {
		for (const html of [
			`<html><body class="loggedin"><main>
				<form action="/mod/assign/view.php?id=701">
					<button type="submit" disabled>提出を追加する</button>
				</form>
			</main></body></html>`,
			'<html><body class="loggedin"><main><p>提出受付は終了しました。</p></main></body></html>',
		]) {
			const { document } = parseHTML(html);
			expect(analyzeAssignmentSubmissionAvailability(document, DETAIL_URL)).toBe("unavailable");
		}
	});

	test("未知DOM・根拠競合・ログイン画面をunknownにする", () => {
		for (const html of [
			'<html><body class="loggedin"><main><p>課題の説明だけです。</p></main></body></html>',
			`<html><body class="loggedin"><main>
				<p>提出受付は終了しました。</p>
				<form action="/mod/assign/view.php?id=701">
					<button type="submit">提出を追加する</button>
				</form>
			</main></body></html>`,
			'<html><body class="notloggedin"><main><form><input type="password"></form></main></body></html>',
			'<html><body class="loggedin"><main><button type="submit">提出を追加する</button></main></body></html>',
		]) {
			const { document } = parseHTML(html);
			expect(analyzeAssignmentSubmissionAvailability(document, DETAIL_URL)).toBe("unknown");
		}
	});

	test("同一オリジン・assign詳細・安定IDを満たすURLだけを正規化する", () => {
		expect(normalizeMoodleAssignmentDetailUrl(`${DETAIL_URL}#main`, BASE_URL)).toBe(DETAIL_URL);
		expect(
			normalizeMoodleAssignmentDetailUrl(`${DETAIL_URL}&action=editsubmission`, BASE_URL),
		).toBe(DETAIL_URL);
		for (const url of [
			"https://evil.example/mod/assign/view.php?id=701",
			"https://moodle2026.wakayama-u.ac.jp/login/index.php",
			"https://moodle2026.wakayama-u.ac.jp/mod/quiz/view.php?id=701",
			"https://moodle2026.wakayama-u.ac.jp/mod/assign/view.php",
			"https://moodle2026.wakayama-u.ac.jp/mod/assign/view.php?id=abc",
			"javascript:alert(1)",
		]) {
			expect(normalizeMoodleAssignmentDetailUrl(url, BASE_URL)).toBeNull();
		}
	});

	test("重複URLを一度だけ取得し、失敗した1件をunknownにして残りを継続する", async () => {
		const hints = [
			hint("assign:701", DETAIL_URL),
			hint("assign:701-copy", `${DETAIL_URL}#main`),
			hint("assign:702", "https://moodle2026.wakayama-u.ac.jp/mod/assign/view.php?id=702"),
		];
		const requested: string[] = [];
		const progress: Array<{ completed: number; total: number }> = [];
		const result = await collectAssignmentSubmissionAvailability(hints, {
			baseUrl: BASE_URL,
			fetch: (async (url) => {
				requested.push(String(url));
				if (String(url).includes("702")) throw new Error("network");
				return htmlResponse(
					`
					<html><body class="loggedin"><main>
						<form action="/mod/assign/view.php?id=701">
							<button type="submit">提出を追加する</button>
						</form>
					</main></body></html>
				`,
					String(url),
				);
			}) as typeof fetch,
			parseHtml: (html) => parseHTML(html).document,
			onProgress: (value) => progress.push(value),
		});

		expect(requested).toHaveLength(2);
		expect(result.map((item) => item.submissionAvailability)).toEqual([
			"available",
			"available",
			"unknown",
		]);
		expect(progress.at(-1)).toMatchObject({ completed: 2, total: 2 });
	});

	test("HTML以外・ログイン画面・想定外リダイレクトはunknownのままにする", async () => {
		const urls = [701, 702, 703, 704].map(
			(id) => `https://moodle2026.wakayama-u.ac.jp/mod/assign/view.php?id=${id}`,
		);
		const result = await collectAssignmentSubmissionAvailability(
			urls.map((url, index) => hint(`assign:${index + 1}`, url)),
			{
				baseUrl: BASE_URL,
				fetch: (async (url) => {
					const requestedUrl = String(url);
					if (requestedUrl.endsWith("701")) {
						return new Response("not html", {
							status: 200,
							headers: { "content-type": "application/json" },
						});
					}
					if (requestedUrl.endsWith("702")) {
						return htmlResponse(
							'<html><body class="notloggedin"><form><input type="password"></form></body></html>',
							requestedUrl,
						);
					}
					const response = htmlResponse(
						'<html><body class="loggedin"><button type="submit">提出を追加する</button></body></html>',
						requestedUrl,
					);
					Object.defineProperty(response, "url", {
						value: requestedUrl.endsWith("703")
							? "https://moodle2026.wakayama-u.ac.jp/login/index.php"
							: "https://moodle2026.wakayama-u.ac.jp/mod/assign/view.php?id=999",
					});
					return response;
				}) as typeof fetch,
				parseHtml: (html) => parseHTML(html).document,
			},
		);
		expect(result.map((item) => item.submissionAvailability)).toEqual([
			"unknown",
			"unknown",
			"unknown",
			"unknown",
		]);
	});

	test("Content-LengthがなくてもHTML上限を超えた時点でunknownにする", async () => {
		const oversized = new Uint8Array(ASSIGNMENT_DETAIL_LIMITS.maxHtmlBytes + 1);
		oversized.fill(0x20);
		const result = await collectAssignmentSubmissionAvailability([hint("assign:701", DETAIL_URL)], {
			baseUrl: BASE_URL,
			fetch: (async () => {
				const response = new Response(oversized, {
					status: 200,
					headers: { "content-type": "text/html" },
				});
				Object.defineProperty(response, "url", { value: DETAIL_URL });
				return response;
			}) as unknown as typeof fetch,
			parseHtml: () => {
				throw new Error("上限超過HTMLは解析しない");
			},
		});
		expect(result[0]?.submissionAvailability).toBe("unknown");
	});

	test("総件数上限を超えた候補は取得せずunknownにする", async () => {
		const hints = Array.from({ length: ASSIGNMENT_DETAIL_LIMITS.maxAssignments + 2 }, (_, index) =>
			hint(
				`assign:${index + 1}`,
				`https://moodle2026.wakayama-u.ac.jp/mod/assign/view.php?id=${index + 1}`,
			),
		);
		let requestCount = 0;
		const result = await collectAssignmentSubmissionAvailability(hints, {
			baseUrl: BASE_URL,
			fetch: (async (url) => {
				requestCount += 1;
				return htmlResponse(
					'<html><body class="loggedin"><main><p>課題の説明</p></main></body></html>',
					String(url),
				);
			}) as typeof fetch,
			parseHtml: (html) => parseHTML(html).document,
		});
		expect(requestCount).toBe(ASSIGNMENT_DETAIL_LIMITS.maxAssignments);
		expect(result.at(-1)?.submissionAvailability).toBe("unknown");
	});
});

function hint(moodleAssignmentId: string, moodleUrl: string): MoodleAssignmentHint {
	return {
		moodleAssignmentId,
		moodleUrl,
		title: "正規化レポート",
		dueText: "提出期限: 2026年7月30日 23:59",
		sourceText: "正規化レポート",
		source: "page_text",
		submitted: false,
		submissionAvailability: "unknown",
	};
}

function htmlResponse(html: string, url: string): Response {
	const response = new Response(html, {
		status: 200,
		headers: { "content-type": "text/html; charset=utf-8" },
	});
	Object.defineProperty(response, "url", { value: url });
	return response;
}
