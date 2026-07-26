// Moodleページで動くコンテンツスクリプトのエントリポイント。
// シェルUI（サイドバー付き検索・締切画面）は ./shell.ts に、
// 資料保存パネル（issue48〜51）は ./savePanel.ts に分離している。
// DOM操作は issue48 のダッシュボード注入と同様に、このディレクトリ内で完結させる。
import "@fuzzy/shared/theme.css";
import { BackgroundApiClient } from "../../lib/api/backgroundApi";
import { buildMoodleAssignmentSyncPayload } from "../../lib/moodle/assignmentSync";
import { classifyMoodlePage, resolveMoodleUiMode } from "../../lib/moodle/pageClassification";
import {
	MOODLE_PAGE_SNAPSHOT_MESSAGE,
	collectMoodlePageSnapshot,
} from "../../lib/moodle/pageSnapshot";
import { collectMoodlePageSnapshotWithNestedFolders } from "../../lib/moodle/snapshotCollector";
import { requestExtensionRuntimeReport } from "../../lib/runtime/extensionRuntime";
import {
	MOODLE_NATIVE_SESSION_PORT,
	maintainMoodleNativeSession,
} from "../../lib/runtime/moodleNativeSession";
import { handleMoodleLoginPage, setupMoodleLogoutTracking } from "./loginAutomation";
import { mountSavePanel } from "./savePanel";
import { mountFuzzyShell } from "./shell";

let disposeMoodleNativeSession: (() => void) | null = null;
let moodlePageActive = true;

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
		// Portはページの寿命と連動して自動切断される。backgroundは認証済みMoodleタブが
		// 1つ以上ある間だけNative Messaging接続を維持する。
		startMoodleNativeSession();
		void reportExtensionRuntimeFromMoodle();
		// イベントリスナーはawait前に登録される。状態掃除の完了はUI起動を待たせない。
		void setupMoodleLogoutTracking(createLoginAutomationOptions()).catch(
			reportLoginAutomationError,
		);
		registerSnapshotMessageListener();
		void syncCurrentCourseAssignments();
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

function startMoodleNativeSession(): void {
	if (disposeMoodleNativeSession) return;
	moodlePageActive = true;
	disposeMoodleNativeSession = maintainMoodleNativeSession({
		connect: () => browser.runtime.connect({ name: MOODLE_NATIVE_SESSION_PORT }),
		isPageActive: () => moodlePageActive,
	});
	window.addEventListener(
		"pagehide",
		() => {
			moodlePageActive = false;
			disposeMoodleNativeSession?.();
			disposeMoodleNativeSession = null;
		},
		{ once: true },
	);
}

async function reportExtensionRuntimeFromMoodle(): Promise<void> {
	try {
		const reported = await requestExtensionRuntimeReport({
			sendMessage: (message) => browser.runtime.sendMessage(message),
		});
		if (!reported) {
			console.warn("[fuzzy] Moodle表示時の拡張機能実行情報を保存できませんでした");
		}
	} catch (error) {
		console.warn("[fuzzy] backgroundへ拡張機能実行情報の再報告を要求できませんでした", error);
	}
}

async function syncCurrentCourseAssignments(): Promise<void> {
	try {
		const snapshot = collectMoodlePageSnapshot(document);
		const request = buildMoodleAssignmentSyncPayload(snapshot, location.href, document);
		if (!request) return;
		await new BackgroundApiClient().syncMoodleAssignments(request);
	} catch (error) {
		// 同期だけを停止し、検索・キャッシュ表示・資料保存など独立した機能は起動する。
		console.warn("[fuzzy] Moodle課題の同期に失敗しました", error);
	}
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
