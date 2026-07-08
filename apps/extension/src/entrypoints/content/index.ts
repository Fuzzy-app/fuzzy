// Moodleページで動くコンテンツスクリプトのエントリポイント。
// シェルUI（サイドバー＋横断検索画面）は ./shell.ts に分離している。
// DOM解析（ファイルリンク・本文・ダッシュボード取得、issue #48）は
// 別モジュールとしてこのディレクトリに追加する想定。
import { mountFuzzyShell } from "./shell";

export default defineContentScript({
	// 拡張機能のマッチパターンはホスト部に「*.」の前置ワイルドカードしか使えないため、
	// 年度で変わるホスト名（moodle2026.wakayama-u.ac.jp 等）を matches だけでは絞り込めない。
	// そこで大学ドメイン全体にマッチさせ、main() 冒頭のホスト名チェックで
	// 「moodle」を含むホストに限定する。
	matches: ["*://*.wakayama-u.ac.jp/*"],
	main() {
		if (!location.hostname.includes("moodle")) return;
		mountFuzzyShell();
	},
});
