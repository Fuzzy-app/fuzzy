import { collectMoodlePageSnapshot } from "../lib/moodle/pageSnapshot";

// Moodleページで動くコンテンツスクリプト。
// DOM解析（ファイルリンク・本文・ダッシュボード取得、issue #48）を行う。
// TODO: matches を大学のMoodleの実URLに合わせる（担当: matoba）。
export default defineContentScript({
	matches: ["*://*.wakayama-u.ac.jp/*"],
	main() {
		const snapshot = collectMoodlePageSnapshot(document);

		console.info("[fuzzy] Moodleページ情報を取得しました", {
			courseName: snapshot.courseName,
			sectionTitle: snapshot.sectionTitle,
			fileCount: snapshot.files.length,
			assignmentHintCount: snapshot.assignmentHints.length,
		});
	},
});
