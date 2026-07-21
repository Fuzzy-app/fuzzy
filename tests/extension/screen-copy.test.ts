import { describe, expect, test } from "bun:test";
import {
	DEADLINE_REVIEW_HELP_TEXT,
	FUZZY_SCREEN_LABELS,
	POPUP_NAVIGATION_GUIDE,
	buildSyncResultNotificationMessage,
} from "../../apps/extension/src/lib/ui/screenCopy";

describe("Fuzzy画面の案内文言", () => {
	test("メニュー・ポップアップ・通知で同じ画面名を使う", () => {
		expect(FUZZY_SCREEN_LABELS).toEqual({
			dashboard: "ダッシュボード",
			search: "資料を検索",
			deadlines: "課題・締切",
			rules: "保存・整理設定",
		});
		expect(POPUP_NAVIGATION_GUIDE).toContain(FUZZY_SCREEN_LABELS.search);
		expect(POPUP_NAVIGATION_GUIDE).toContain(FUZZY_SCREEN_LABELS.deadlines);
		expect(POPUP_NAVIGATION_GUIDE).toContain(FUZZY_SCREEN_LABELS.rules);
		expect(buildSyncResultNotificationMessage(3)).toBe(
			`変更が3件あります。${FUZZY_SCREEN_LABELS.deadlines}で確認できます。`,
		);
		expect(buildSyncResultNotificationMessage(0)).toBe("変更はありません。");
	});

	test("締切日の要確認状態を取得失敗に限定しない", () => {
		expect(DEADLINE_REVIEW_HELP_TEXT).toContain("学期の範囲から外れているなど");
		expect(DEADLINE_REVIEW_HELP_TEXT).toContain("締切日の再確認が必要");
		expect(DEADLINE_REVIEW_HELP_TEXT).not.toContain("取得できなかった");
	});
});
