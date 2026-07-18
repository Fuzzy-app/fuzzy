// Moodleページで動くコンテンツスクリプトのエントリポイント。
// シェルUI（サイドバー付き検索・締切画面）は ./shell.ts に、
// 資料保存パネル（issue48〜51）は ./savePanel.ts に分離している。
// DOM操作は issue48 のダッシュボード注入と同様に、このディレクトリ内で完結させる。
import "@fuzzy/shared/theme.css";
import { MOODLE_PAGE_SNAPSHOT_MESSAGE } from "../../lib/moodle/pageSnapshot";
import { collectMoodlePageSnapshotWithNestedFolders } from "../../lib/moodle/snapshotCollector";
import { handleMoodleLoginPage, setupMoodleLogoutTracking } from "./loginAutomation";
import { mountSavePanel } from "./savePanel";
import { mountFuzzyShell } from "./shell";

export default defineContentScript({
	// 年度で変わるホスト名（moodle2026.wakayama-u.ac.jp 等）を
	// matches だけでは細かく絞り込めないため、
	// main() 内部の正規表現で moodle[数字].wakayama-u.ac.jp の形式だけに限定する。
	// 数字部分は任意（\d*）なので、年度なしの moodle.wakayama-u.ac.jp も許可する。
	matches: ["*://*.wakayama-u.ac.jp/*"],
	main() {
		if (!/^moodle\d*\.wakayama-u\.ac\.jp$/.test(location.hostname)) return;
		void initializeMoodleContent();
	},
});

async function initializeMoodleContent(): Promise<void> {
	await setupMoodleLogoutTracking({
		document,
		pageUrl: location.href,
		panelStateStorage: browser.storage.local,
		sessionStorage: window.sessionStorage,
		navigate: (url) => location.assign(url),
	});
	const loginResult = await handleMoodleLoginPage({
		document,
		pageUrl: location.href,
		panelStateStorage: browser.storage.local,
		sessionStorage: window.sessionStorage,
	});
	// ログイン画面では保存パネルやFuzzyシェルを重ねず、手動ログインの導線も残す。
	if (loginResult !== "not-login-page") return;

	registerSnapshotMessageListener();
	mountFuzzyShell();
	void mountSavePanel();
}

// background等からのスナップショット要求（issue48のデータ取得口）に応答する。
function registerSnapshotMessageListener(): void {
	browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
		if ((message as { type?: string } | null)?.type !== MOODLE_PAGE_SNAPSHOT_MESSAGE) return false;

		void collectMoodlePageSnapshotWithNestedFolders().then((snapshot) => {
			sendResponse({ snapshot });
		});
		return true;
	});
}
