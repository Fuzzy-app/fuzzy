import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { buildShellScreenHeader } from "../../apps/extension/src/entrypoints/content/shellElements";
import {
	DEADLINE_REVIEW_HELP_TEXT,
	FUZZY_SCREENS,
	POPUP_NAVIGATION_GUIDE,
	buildSyncResultNotificationMessage,
} from "../../apps/extension/src/lib/ui/screenCopy";

describe("Fuzzy画面の案内文言", () => {
	test("メニュー・ポップアップ・通知で同じ画面名を使う", () => {
		expect(FUZZY_SCREENS.search).toMatchObject({
			navigationLabel: "資料を検索",
			kicker: "資料検索",
			title: "どのファイルに載っているか",
		});
		expect(FUZZY_SCREENS.deadlines.navigationLabel).toBe("課題・締切");
		expect(FUZZY_SCREENS.rules.navigationLabel).toBe("保存・整理設定");
		expect(POPUP_NAVIGATION_GUIDE).toContain(FUZZY_SCREENS.search.navigationLabel);
		expect(POPUP_NAVIGATION_GUIDE).toContain(FUZZY_SCREENS.deadlines.navigationLabel);
		expect(POPUP_NAVIGATION_GUIDE).toContain(FUZZY_SCREENS.rules.navigationLabel);
		expect(buildSyncResultNotificationMessage(3)).toBe(
			`変更が3件あります。「${FUZZY_SCREENS.deadlines.navigationLabel}」画面で確認できます。`,
		);
		expect(buildSyncResultNotificationMessage(0)).toBe("変更はありません。");
	});

	test("締切日の要確認状態を取得失敗に限定しない", () => {
		expect(DEADLINE_REVIEW_HELP_TEXT).toContain("学期の範囲から外れているなど");
		expect(DEADLINE_REVIEW_HELP_TEXT).toContain("締切日の再確認が必要");
		expect(DEADLINE_REVIEW_HELP_TEXT).not.toContain("取得できなかった");
	});

	test("画面ヘッダーも共通定義の表示名を使う", () => {
		const { document, window } = parseHTML("<html><body></body></html>");
		Object.assign(globalThis, {
			document,
			window,
			HTMLElement: window.HTMLElement,
		});

		const header = buildShellScreenHeader("search");
		expect(header.querySelector(".fuzzy-screen-kicker")?.textContent).toBe(
			FUZZY_SCREENS.search.kicker,
		);
		expect(header.querySelector("h1")?.textContent).toBe(FUZZY_SCREENS.search.title);
	});
});
