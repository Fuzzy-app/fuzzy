// Moodleページで動くコンテンツスクリプトのエントリポイント。
// シェルUI（サイドバー付き検索・締切画面）は ./shell.ts に、
// 資料保存パネル（issue48〜51）は ./savePanel.ts に分離している。
// DOM操作は issue48 のダッシュボード注入と同様に、このディレクトリ内で完結させる。
import "@fuzzy/shared/theme.css";
import { MOODLE_HTTPS_MATCH_PATTERNS, isSupportedMoodleHostname } from "../../../moodleSite";
import { BackgroundApiClient } from "../../lib/api/backgroundApi";
import {
	type AssignmentDetailProgress,
	collectAssignmentSubmissionAvailability,
} from "../../lib/moodle/assignmentDetail";
import {
	buildCourseFileReconcilePayload,
	buildMoodleAssignmentSyncPayload,
} from "../../lib/moodle/assignmentSync";
import {
	classifyMoodlePage,
	isMoodleCoursePage,
	isMoodleDashboardPage,
	resolveMoodleUiMode,
} from "../../lib/moodle/pageClassification";
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
import {
	showAssignmentDetailProgress,
	showAssignmentSyncComplete,
	showAssignmentSyncFailure,
	showAssignmentSyncSaving,
} from "./moodleAssignmentSyncStatus";
import { mountSavePanel } from "./savePanel";
import { mountFuzzyShell } from "./shell";

let disposeMoodleNativeSession: (() => void) | null = null;
let moodlePageActive = true;

export default defineContentScript({
	// 和歌山大学側は年度でホスト名が変わるため、matchesのワイルドカードに加えて
	// main()でも対応ホストを限定する。審査用MoodleCloudは完全一致でだけ許可する。
	matches: [...MOODLE_HTTPS_MATCH_PATTERNS],
	main() {
		if (!isSupportedMoodleHostname(location.hostname)) return;
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
		if (isMoodleCoursePage(location.href)) {
			void syncCurrentCourseData();
		} else if (isMoodleDashboardPage(location.href)) {
			void syncMoodleDashboardCourses();
		}
		mountFuzzyShell();
		if (isMoodleCoursePage(location.href)) void mountSavePanel();
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

async function syncCurrentCourseData(): Promise<void> {
	let snapshot: ReturnType<typeof collectMoodlePageSnapshot>;
	let assignmentRequest: ReturnType<typeof buildMoodleAssignmentSyncPayload>;
	let fileRequest: ReturnType<typeof buildCourseFileReconcilePayload>;
	try {
		snapshot = collectMoodlePageSnapshot(document);
		assignmentRequest = buildMoodleAssignmentSyncPayload(snapshot, location.href, document);
		fileRequest = buildCourseFileReconcilePayload(snapshot, location.href, document);
	} catch (error) {
		console.warn("[fuzzy] Moodleコース情報を読み取れませんでした", error);
		return;
	}
	const client = new BackgroundApiClient();
	const operations: Promise<unknown>[] = [];
	if (assignmentRequest) {
		operations.push(syncAssignmentsWithDetails(client, snapshot, location.href, document));
	}
	if (fileRequest) {
		operations.push(
			client.reconcileCourseFiles(fileRequest).catch((error) => {
				console.warn("[fuzzy] コース資料の差分更新に失敗しました", error);
			}),
		);
	}
	// 同期失敗は検索・キャッシュ表示・資料保存など独立した機能へ波及させない。
	await Promise.all(operations);
}

/**
 * ダッシュボードには課題の一覧だけが載り、提出可否や全セクションの完全性が
 * ないことがある。ダッシュボード上の授業リンクを少数ずつ取得し、通常の
 * 完全コースsnapshotとして同期することで、表示中の授業だけに限定した安全策を保つ。
 */
async function syncMoodleDashboardCourses(): Promise<void> {
	const courseUrls = Array.from(
		document.querySelectorAll<HTMLAnchorElement>("a[href*='/course/view.php']"),
	)
		.map((link) => {
			try {
				const url = new URL(link.href, location.href);
				return url.origin === location.origin && /\/course\/view\.php$/i.test(url.pathname)
					? url.toString()
					: null;
			} catch {
				return null;
			}
		})
		.filter((url): url is string => url !== null)
		.filter((url, index, values) => values.indexOf(url) === index)
		.slice(0, 12);
	if (courseUrls.length === 0) return;

	const client = new BackgroundApiClient();
	await Promise.all(courseUrls.map((url) => syncFetchedCourse(client, url)));
}

async function syncFetchedCourse(client: BackgroundApiClient, pageUrl: string): Promise<void> {
	const controller = new AbortController();
	const timeout = window.setTimeout(() => controller.abort(), 8_000);
	try {
		const response = await fetch(pageUrl, {
			credentials: "include",
			signal: controller.signal,
		});
		if (!response.ok) return;
		const html = await response.text();
		const courseDocument = new DOMParser().parseFromString(html, "text/html");
		const base = courseDocument.createElement("base");
		base.href = pageUrl;
		courseDocument.head.prepend(base);
		const snapshot = collectMoodlePageSnapshot(courseDocument);
		const assignmentRequest = buildMoodleAssignmentSyncPayload(snapshot, pageUrl, courseDocument);
		const fileRequest = buildCourseFileReconcilePayload(snapshot, pageUrl, courseDocument);
		const operations: Promise<unknown>[] = [];
		if (assignmentRequest) {
			operations.push(syncAssignmentsWithDetails(client, snapshot, pageUrl, courseDocument));
		}
		if (fileRequest) {
			operations.push(
				client.reconcileCourseFiles(fileRequest).catch((error) => {
					console.warn("[fuzzy] 背景でのコース資料更新に失敗しました", error);
				}),
			);
		}
		await Promise.all(operations);
	} catch (error) {
		console.warn("[fuzzy] ダッシュボードから授業情報を更新できませんでした", error);
	} finally {
		window.clearTimeout(timeout);
	}
}

async function syncAssignmentsWithDetails(
	client: BackgroundApiClient,
	snapshot: ReturnType<typeof collectMoodlePageSnapshot>,
	pageUrl: string,
	root: Document,
): Promise<void> {
	let progress: AssignmentDetailProgress = {
		completed: 0,
		total: 0,
		unknown: 0,
		skipped: 0,
	};
	try {
		const assignmentHints = await collectAssignmentSubmissionAvailability(
			snapshot.assignmentHints,
			{
				baseUrl: pageUrl,
				onProgress: (value) => {
					progress = value;
					showAssignmentDetailProgress(value);
				},
			},
		);
		const request = buildMoodleAssignmentSyncPayload(
			{ ...snapshot, assignmentHints },
			pageUrl,
			root,
		);
		if (!request) return;
		showAssignmentSyncSaving();
		await client.syncMoodleAssignments(request);
		showAssignmentSyncComplete(progress);
	} catch (error) {
		console.warn("[fuzzy] Moodle課題の同期に失敗しました", error);
		showAssignmentSyncFailure(error);
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
