import {
	ApiError,
	type CheckSimilarFilesRequest,
	type DataSyncEvent,
	type FuzzyApiClient,
	type MoodleSaveFilesRequest,
	createApiClient,
} from "@fuzzy/shared";
import {
	type FuzzyApiRequestMessage,
	type FuzzyApiResponseMessage,
	hasValidFuzzyApiRequestPayload,
	isFuzzyApiRequestMessage,
	toBackgroundApiError,
} from "../lib/api/backgroundApi";
import { callBackgroundApi } from "../lib/api/backgroundDispatch";
import {
	checkMoodleFileFromBackground,
	saveMoodleFilesFromBackground,
} from "../lib/api/backgroundFileSave";
import { createRecoveringApiClientProvider } from "../lib/api/recoveringClient";
import { readDashboardCache, writeDashboardCache } from "../lib/cache/dashboardCache";
import {
	type DashboardCacheReadResponseMessage,
	isDashboardCacheReadRequestMessage,
} from "../lib/cache/dashboardCacheMessaging";
import { createDeadlineNotificationMonitor } from "../lib/notifications/deadlineNotificationMonitor";
import {
	isRuleManagementRequestMessage,
	respondToRuleManagementRequest,
} from "../lib/rules/backgroundApi";
import {
	isExtensionRuntimeReportRequestMessage,
	reportCurrentExtensionRuntime,
} from "../lib/runtime/extensionRuntime";
import { MOODLE_NATIVE_SESSION_PORT } from "../lib/runtime/moodleNativeSession";
import { buildSyncResultNotificationMessage } from "../lib/ui/screenCopy";

const SYNC_CHECK_ALARM = "fuzzy-check-latest-sync-event";
const SYNC_NOTIFICATION_KEY_PREFIX = "fuzzy-last-notified-sync-event";
const SYNC_CHECK_INTERVAL_MINUTES = 1;
let syncNotificationQueue: Promise<void> = Promise.resolve();

function syncChangeTotal(event: DataSyncEvent): number {
	return event.newAssignmentCount + event.changedAssignmentCount + event.removedAssignmentCount;
}

async function notifyWhenSyncEventIsNew(client: FuzzyApiClient): Promise<void> {
	// 画面開発用のサンプル同期履歴から実通知を生成しない。
	if (client.mode === "mock") return;
	const event = await client.getLatestSyncEvent();
	if (!event) return;

	const storageKey = `${SYNC_NOTIFICATION_KEY_PREFIX}:${client.mode}`;
	const stored = await browser.storage.local.get(storageKey);
	const previousEventId = stored[storageKey] as number | undefined;

	// 初回起動時は、過去の同期を通知せず、次回以降の新しい同期だけを通知する。
	if (previousEventId === undefined) {
		await browser.storage.local.set({ [storageKey]: event.id });
		return;
	}
	if (previousEventId !== undefined && previousEventId >= event.id) return;

	await queueSyncEventNotification(client.mode, event);
}

function queueSyncEventNotification(
	mode: FuzzyApiClient["mode"],
	event: DataSyncEvent,
): Promise<void> {
	const queued = syncNotificationQueue.then(() => deliverSyncEventNotification(mode, event));
	syncNotificationQueue = queued.catch(() => undefined);
	return queued;
}

async function deliverSyncEventNotification(
	mode: FuzzyApiClient["mode"],
	event: DataSyncEvent,
): Promise<void> {
	// 呼び出し元のsyncMoodleAssignmentsが成功したeventは初回baselineと区別し、
	// 必ずその場で通知する。同じIDはChrome側で同じ通知を置き換える。
	if (mode === "mock") return;
	const total = syncChangeTotal(event);
	await browser.notifications.create(`fuzzy-sync-${mode}-${event.id}`, {
		type: "basic",
		iconUrl: browser.runtime.getURL("/icon/128.png"),
		title: "Fuzzy: Moodleデータを取得しました",
		message: buildSyncResultNotificationMessage(total),
	});
	const storageKey = `${SYNC_NOTIFICATION_KEY_PREFIX}:${mode}`;
	const stored = await browser.storage.local.get(storageKey);
	const previousEventId =
		typeof stored[storageKey] === "number" ? (stored[storageKey] as number) : 0;
	await browser.storage.local.set({
		[storageKey]: Math.max(previousEventId, event.id),
	});
}

// Native Messaging接続（native-host疎通）はbackgroundに集約する（仕様書3.4節）。
// content script側は lib/api/backgroundApi.ts の BackgroundApiClient から
// runtimeメッセージでここへ委譲する。
export default defineBackground(() => {
	const activeMoodleSessions = new Set<unknown>();
	const hasActiveMoodleSession = () => activeMoodleSessions.size > 0;
	const clientProvider = createRecoveringApiClientProvider({
		createClient: () => createApiClient(),
	});
	const getClient = (): Promise<FuzzyApiClient> => clientProvider.getClient();
	const handleClientError = (error: unknown): void => {
		if (
			error instanceof ApiError &&
			(error.code === "NO_NATIVE_HOST" || error.code === "TIMEOUT")
		) {
			clientProvider.invalidate();
		}
	};
	const deadlineNotificationMonitor = createDeadlineNotificationMonitor(getClient, {
		shouldCheck: hasActiveMoodleSession,
		onError: handleClientError,
	});
	let runtimeReportPromise: Promise<boolean> | null = null;

	const reportExtensionRuntimeOnce = (): Promise<boolean> => {
		if (runtimeReportPromise) return runtimeReportPromise;

		const reportPromise = reportCurrentExtensionRuntime()
			.then(() => true)
			.catch((error) => {
				console.warn("[fuzzy] 拡張機能の実行情報をnative-hostへ保存できませんでした", error);
				return false;
			})
			.finally(() => {
				if (runtimeReportPromise === reportPromise) runtimeReportPromise = null;
			});
		runtimeReportPromise = reportPromise;
		return reportPromise;
	};

	const checkLatestSyncEvent = async () => {
		if (!hasActiveMoodleSession()) return;
		try {
			await notifyWhenSyncEventIsNew(await getClient());
		} catch (error) {
			handleClientError(error);
			console.warn("[fuzzy] 同期結果の通知確認に失敗しました", error);
		}
	};

	const startSyncNotificationMonitoring = () => {
		browser.alarms.create(SYNC_CHECK_ALARM, {
			periodInMinutes: SYNC_CHECK_INTERVAL_MINUTES,
		});
		void checkLatestSyncEvent();
	};

	const startNotificationMonitoring = () => {
		startSyncNotificationMonitoring();
		deadlineNotificationMonitor.start();
		void reportExtensionRuntimeOnce();
	};

	browser.runtime.onInstalled.addListener(startNotificationMonitoring);
	browser.runtime.onStartup.addListener(startNotificationMonitoring);
	browser.runtime.onConnect.addListener((port) => {
		if (port.name !== MOODLE_NATIVE_SESSION_PORT) return;
		activeMoodleSessions.add(port);
		if (activeMoodleSessions.size === 1) {
			void checkLatestSyncEvent();
			void deadlineNotificationMonitor.check();
		}
		port.onDisconnect.addListener(() => {
			activeMoodleSessions.delete(port);
			if (!hasActiveMoodleSession()) clientProvider.dispose();
		});
	});
	browser.alarms.onAlarm.addListener((alarm) => {
		if (alarm.name === SYNC_CHECK_ALARM) void checkLatestSyncEvent();
		if (alarm.name === deadlineNotificationMonitor.alarmName) {
			void deadlineNotificationMonitor.check();
		}
	});
	startNotificationMonitoring();

	browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
		if (isExtensionRuntimeReportRequestMessage(message)) {
			void reportExtensionRuntimeOnce().then((ok) => sendResponse({ ok }));
			return true;
		}
		if (isDashboardCacheReadRequestMessage(message)) {
			void respondToDashboardCacheReadRequest().then(sendResponse);
			return true;
		}
		if (isRuleManagementRequestMessage(message)) {
			void respondToRuleManagementRequest(getClient(), message, handleClientError).then(
				sendResponse,
			);
			return true;
		}
		if (!isFuzzyApiRequestMessage(message)) return false;

		void respondToApiRequest(
			getClient(),
			message,
			sender.tab?.url ?? sender.url ?? "",
			handleClientError,
		).then(sendResponse);
		return true; // sendResponse を非同期に呼ぶため、メッセージチャネルを維持する
	});
});

async function respondToApiRequest(
	clientPromise: Promise<FuzzyApiClient>,
	message: FuzzyApiRequestMessage,
	senderUrl = "",
	onError?: (error: unknown) => void,
): Promise<FuzzyApiResponseMessage> {
	if (!hasValidFuzzyApiRequestPayload(message)) {
		return {
			ok: false,
			error: { code: "INVALID_REQUEST", message: "リクエストの内容が不正です。" },
		};
	}
	try {
		const client = await clientPromise;
		const data =
			message.method === "saveFiles"
				? await saveMoodleFilesFromBackground(
						client,
						message.request as MoodleSaveFilesRequest,
						pageOrigin(senderUrl),
					)
				: message.method === "checkSimilarFiles"
					? await checkMoodleFileFromBackground(
							client,
							message.request as CheckSimilarFilesRequest,
							pageOrigin(senderUrl),
						)
					: await callBackgroundApi(client, message, {
							writeDashboardCache,
							notifySyncEvent: (event) => queueSyncEventNotification(client.mode, event),
							onSyncNotificationError: (error) => {
								console.warn("[fuzzy] 同期結果を通知できませんでした", error);
							},
						});
		return { ok: true, data, mode: client.mode };
	} catch (error) {
		onError?.(error);
		return {
			ok: false,
			error: toBackgroundApiError(error),
		};
	}
}

async function respondToDashboardCacheReadRequest(): Promise<DashboardCacheReadResponseMessage> {
	try {
		return { ok: true, data: await readDashboardCache() };
	} catch {
		return {
			ok: false,
			error: { code: "CACHE_READ_FAILED", message: "キャッシュを読み込めませんでした。" },
		};
	}
}

function pageOrigin(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return "";
	}
}
