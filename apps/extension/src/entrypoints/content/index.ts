// Moodleページで動くコンテンツスクリプトのエントリポイント。
// シェルUI（サイドバー付き検索・締切画面）は ./shell.ts に、
// 資料保存パネル（issue48〜51）は ./savePanel.ts に分離している。
// DOM操作は issue48 のダッシュボード注入と同様に、このディレクトリ内で完結させる。
import "@fuzzy/shared/theme.css";
import { classifyMoodlePage, resolveMoodleUiMode } from "../../lib/moodle/pageClassification";
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
	matches: ["https://*.wakayama-u.ac.jp/*"],
	main() {
		if (!/^moodle\d*\.wakayama-u\.ac\.jp$/.test(location.hostname)) return;
		initializeMoodleContent();
	},
});

function initializeMoodleContent(): void {
	const pageKind = classifyMoodlePage(document, location.href);
	const uiMode = resolveMoodleUiMode(pageKind);

	if (uiMode === "full") {
		// イベントリスナーはawait前に登録される。状態掃除の完了はUI起動を待たせない。
		void setupMoodleLogoutTracking(createLoginAutomationOptions()).catch(
			reportLoginAutomationError,
		);
		registerSnapshotMessageListener();
		mountFuzzyShell();
		void mountSavePanel();
		return;
	}

	if (uiMode === "shell-only") {
		// Moodleが同一オリジンの障害HTMLを返した場合は、DOM収集をせずキャッシュ表示だけ提供する。
		mountFuzzyShell();
		return;
	}

	if (pageKind === "logout-transition") {
		void setupMoodleLogoutTracking(createLoginAutomationOptions()).catch(
			reportLoginAutomationError,
		);
		return;
	}
	if (pageKind === "login" || pageKind === "authentication-transition") {
		void handleMoodleLoginPage(createLoginAutomationOptions()).catch(reportLoginAutomationError);
	}
	// unauthenticatedではMoodle DOM収集・Fuzzy UI起動・ストレージ処理を行わない。
}

function createLoginAutomationOptions() {
	return {
		document,
		pageUrl: location.href,
		panelStateStorage: browser.storage.local,
		sessionStorage: window.sessionStorage,
		navigate: (url: string) => location.assign(url),
	};
}

function reportLoginAutomationError(error: unknown): void {
	console.warn("[fuzzy] Moodleログイン補助を完了できませんでした", error);
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
