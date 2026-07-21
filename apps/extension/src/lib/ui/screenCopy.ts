export const FUZZY_SCREEN_LABELS = {
	dashboard: "ダッシュボード",
	search: "資料を検索",
	deadlines: "課題・締切",
	rules: "保存・整理設定",
} as const;

export type FuzzyScreenId = keyof typeof FUZZY_SCREEN_LABELS;

export const DEADLINE_REVIEW_HELP_TEXT =
	"提出済みにすると一覧へすぐ反映されます。「締切日を確認」は、学期の範囲から外れているなど、締切日の再確認が必要な課題です。";

export const POPUP_NAVIGATION_GUIDE = `「${FUZZY_SCREEN_LABELS.search}」「${FUZZY_SCREEN_LABELS.deadlines}」「${FUZZY_SCREEN_LABELS.rules}」は、上部ナビの「Fuzzy」タブから開く`;

export function buildSyncResultNotificationMessage(changeCount: number): string {
	return changeCount > 0
		? `変更が${changeCount}件あります。${FUZZY_SCREEN_LABELS.deadlines}で確認できます。`
		: "変更はありません。";
}
