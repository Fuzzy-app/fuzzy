import {
	MOODLE_PAGE_SNAPSHOT_MESSAGE,
	collectMoodlePageSnapshot,
} from "../lib/moodle/pageSnapshot";

// Moodleページで動くコンテンツスクリプト。
// DOM解析（ファイルリンク・本文・ダッシュボード取得、issue #48）を行う。
// TODO: matches を大学のMoodleの実URLに合わせる（担当: matoba）。
export default defineContentScript({
	matches: ["*://*.wakayama-u.ac.jp/*"],
	main() {
		const snapshot = collectMoodlePageSnapshot(document);
		const runtime = getChromeRuntime();
		const addMessageListener = runtime?.onMessage?.addListener;

		if (addMessageListener) {
			addMessageListener((message, _sender, sendResponse) => {
				if (message?.type !== MOODLE_PAGE_SNAPSHOT_MESSAGE) return false;

				sendResponse({ snapshot: collectMoodlePageSnapshot(document) });
				return true;
			});
		}

		console.info("[fuzzy] Moodleページ情報を取得しました", {
			courseName: snapshot.courseName,
			sectionTitle: snapshot.sectionTitle,
			fileCount: snapshot.files.length,
			assignmentHintCount: snapshot.assignmentHints.length,
		});
	},
});

function getChromeRuntime():
	| { onMessage?: { addListener?: (listener: MessageListener) => void } }
	| undefined {
	// biome-ignore lint/suspicious/noExplicitAny: content scriptではブラウザが注入するchromeを参照するため
	return (globalThis as any).chrome?.runtime;
}

type MessageListener = (
	message: { type?: string },
	sender: unknown,
	sendResponse: (response: unknown) => void,
) => boolean;
