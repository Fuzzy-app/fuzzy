import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
	classifyMoodlePage,
	resolveMoodleUiMode,
} from "../../apps/extension/src/lib/moodle/pageClassification";

const ORIGIN = "https://moodle2026.wakayama-u.ac.jp";

describe("Moodleページの起動判定", () => {
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
