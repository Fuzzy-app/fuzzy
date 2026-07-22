export const FUZZY_SCREENS = {
	dashboard: {
		navigationLabel: "ダッシュボード",
		kicker: "ダッシュボード",
		title: "学習状況をひと目で確認",
		description: "資料と締切の概要",
	},
	search: {
		navigationLabel: "資料を検索",
		kicker: "資料検索",
		title: "どのファイルに載っているか",
		description: "保存した資料を検索",
	},
	deadlines: {
		navigationLabel: "課題・締切",
		kicker: "課題・締切",
		title: "課題と提出状況をまとめて確認",
		description: "課題と締切を確認",
	},
	rules: {
		navigationLabel: "保存・整理設定",
		kicker: "保存・整理設定",
		title: "資料の保存方法を設定",
		description: "保存方法と整理が必要な資料を確認",
	},
} as const;

export type FuzzyScreenId = keyof typeof FUZZY_SCREENS;

export const FUZZY_SCREEN_ORDER = [
	"dashboard",
	"search",
	"deadlines",
	"rules",
] as const satisfies readonly FuzzyScreenId[];

export const DEADLINE_REVIEW_HELP_TEXT =
	"提出済みにすると一覧へすぐ反映されます。「締切日を確認」は、学期の範囲から外れているなど、締切日の再確認が必要な課題です。";

export const POPUP_NAVIGATION_GUIDE = `「${FUZZY_SCREENS.search.navigationLabel}」「${FUZZY_SCREENS.deadlines.navigationLabel}」「${FUZZY_SCREENS.rules.navigationLabel}」は、上部ナビの「Fuzzy」タブから開く`;

export function buildSyncResultNotificationMessage(changeCount: number): string {
	return changeCount > 0
		? `変更が${changeCount}件あります。「${FUZZY_SCREENS.deadlines.navigationLabel}」画面で確認できます。`
		: "変更はありません。";
}
