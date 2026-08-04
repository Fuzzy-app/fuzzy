import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
	classifyMoodlePage,
	isMoodleDashboardPage,
	resolveMoodleUiMode,
} from "../../apps/extension/src/lib/moodle/pageClassification";

const ORIGIN = "https://moodle2026.wakayama-u.ac.jp";

describe("Moodleページの起動判定", () => {
	test("年度付きのMoodleダッシュボードを背景同期の起点と判定する", () => {
		expect(isMoodleDashboardPage(`${ORIGIN}/2026/my/`)).toBe(true);
		expect(isMoodleDashboardPage(`${ORIGIN}/2026/dashboard/index.php`)).toBe(true);
		expect(isMoodleDashboardPage(`${ORIGIN}/2026/course/view.php?id=1`)).toBe(false);
	});

	test("認証済みページでは全機能を起動する", () => {
		const { document } = parseHTML('<html><body class="loggedin"></body></html>');
		const kind = classifyMoodlePage(document, `${ORIGIN}/2026/my/`);

		expect(kind).toBe("authenticated");
		expect(resolveMoodleUiMode(kind)).toBe("full");
	});

	test("未ログインの公開ページでは処理しない", () => {
		const { document } = parseHTML(
			'<html><body class="notloggedin"><main>公開情報</main></body></html>',
		);
		const kind = classifyMoodlePage(document, `${ORIGIN}/2026/course/view.php?id=1`);

		expect(kind).toBe("unauthenticated");
		expect(resolveMoodleUiMode(kind)).toBe("none");
	});

	test("MoodleCloudのゲストコースではDOM同期を含む全機能を起動する", () => {
		const { document } = parseHTML(`
			<html><body class="notloggedin path-course">
				<div class="logininfo">あなたは現在ゲストアクセスを利用しています <a href="/login/index.php">ログイン</a></div>
				<main><div class="course-content"><section class="course-section"></section></div></main>
			</body></html>
		`);
		const kind = classifyMoodlePage(
			document,
			"https://fuzzy-qa-2026.moodlecloud.com/course/view.php?id=9",
		);

		expect(kind).toBe("guest");
		expect(resolveMoodleUiMode(kind)).toBe("full");
	});

	test("本文にguestという語があるだけの公開ページはゲストコースと誤認しない", () => {
		const { document } = parseHTML(`
			<html><body class="notloggedin">
				<main><div class="course-content">Guest accessの説明</div></main>
			</body></html>
		`);
		const kind = classifyMoodlePage(
			document,
			"https://fuzzy-qa-2026.moodlecloud.com/course/view.php?id=9",
		);

		expect(kind).toBe("unauthenticated");
		expect(resolveMoodleUiMode(kind)).toBe("none");
	});

	test("和歌山大学側のゲストコースは審査用例外として起動しない", () => {
		const { document } = parseHTML(`
			<html><body class="notloggedin path-course">
				<div class="logininfo">あなたは現在ゲストアクセスを利用しています</div>
				<main><div class="course-content"></div></main>
			</body></html>
		`);
		const kind = classifyMoodlePage(
			document,
			"https://moodle2026.wakayama-u.ac.jp/course/view.php?id=9",
		);

		expect(kind).toBe("unauthenticated");
		expect(resolveMoodleUiMode(kind)).toBe("none");
	});

	test("既知のログイン画面だけをログイン補助の対象にする", () => {
		const { document } = parseHTML(`
			<html><body class="notloggedin">
				<a href="/2026/auth/oidc/">和歌山大学ID（利用者@wakayama-u.ac.jp）でログインする</a>
			</body></html>
		`);
		const kind = classifyMoodlePage(document, `${ORIGIN}/2026/login/index_form.html`);

		expect(kind).toBe("login");
		expect(resolveMoodleUiMode(kind)).toBe("none");
	});

	test("Moodleの障害HTMLではキャッシュ表示用シェルだけを起動する", () => {
		const { document } = parseHTML(`
			<html><body><main><h1>Service Unavailable</h1></main></body></html>
		`);
		const kind = classifyMoodlePage(document, `${ORIGIN}/2026/`);

		expect(kind).toBe("unavailable");
		expect(resolveMoodleUiMode(kind)).toBe("shell-only");
	});

	test("認証・ログアウト遷移ページにはUIを重ねない", () => {
		const { document } = parseHTML("<html><body></body></html>");
		const authentication = classifyMoodlePage(document, `${ORIGIN}/2026/auth/oidc/`);
		const logout = classifyMoodlePage(document, `${ORIGIN}/2026/login/logout.php`);

		expect(authentication).toBe("authentication-transition");
		expect(logout).toBe("logout-transition");
		expect(resolveMoodleUiMode(authentication)).toBe("none");
		expect(resolveMoodleUiMode(logout)).toBe("none");
	});
});
