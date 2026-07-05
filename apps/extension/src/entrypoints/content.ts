// Moodleページで動くコンテンツスクリプトの雛形。
// DOM解析（ファイルリンク・本文・ダッシュボード取得、issue #48）はここに実装する。
// TODO: matches を大学のMoodleの実URLに合わせる（担当: matoba）。
export default defineContentScript({
	matches: ["*://*.wakayama-u.ac.jp/*"],
	main() {
		console.log("[fuzzy] content script 読み込み");
	},
});
