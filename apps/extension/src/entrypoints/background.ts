import {
	type DataSyncEvent,
	type FuzzyApiClient,
	type MoodleSaveFilesRequest,
	createApiClient,
} from "@fuzzy/shared";
import {
	type FuzzyApiRequestMessage,
	type FuzzyApiResponseMessage,
	isFuzzyApiRequestMessage,
	toBackgroundApiError,
} from "../lib/api/backgroundApi";
import { callBackgroundApi } from "../lib/api/backgroundDispatch";
import { saveMoodleFilesFromBackground } from "../lib/api/backgroundFileSave";
import { createDeadlineNotificationMonitor } from "../lib/notifications/deadlineNotificationMonitor";
import {
	isRuleManagementRequestMessage,
	respondToRuleManagementRequest,
} from "../lib/rules/backgroundApi";
import { reportCurrentExtensionRuntime } from "../lib/runtime/extensionRuntime";
import { buildSyncResultNotificationMessage } from "../lib/ui/screenCopy";

const SYNC_CHECK_ALARM = "fuzzy-check-latest-sync-event";
const SYNC_NOTIFICATION_KEY_PREFIX = "fuzzy-last-notified-sync-event";
const SYNC_CHECK_INTERVAL_MINUTES = 1;

function syncChangeTotal(event: DataSyncEvent): number {
	return event.newAssignmentCount + event.changedAssignmentCount + event.removedAssignmentCount;
}

async function notifyWhenSyncEventIsNew(client: FuzzyApiClient): Promise<void> {
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
	if (previousEventId === event.id) return;

	const total = syncChangeTotal(event);
	await browser.notifications.create(`fuzzy-sync-${client.mode}-${event.id}`, {
		type: "basic",
		iconUrl: browser.runtime.getURL("/icon/128.png"),
		title: "Fuzzy: Moodleデータを取得しました",
		message: buildSyncResultNotificationMessage(total),
	});
	await browser.storage.local.set({ [storageKey]: event.id });
}

// Native Messaging接続（native-host疎通）はbackgroundに集約する（仕様書3.4節）。
// content script側は lib/api/backgroundApi.ts の BackgroundApiClient から
// runtimeメッセージでここへ委譲する。
export default defineBackground(() => {
	let clientPromise: Promise<FuzzyApiClient> | null = null;
	const getClient = (): Promise<FuzzyApiClient> => {
		if (!clientPromise) clientPromise = createApiClient();
		return clientPromise;
	};
	const deadlineNotificationMonitor = createDeadlineNotificationMonitor(getClient);

	const checkLatestSyncEvent = async () => {
		try {
			await notifyWhenSyncEventIsNew(await getClient());
		} catch (error) {
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
		void reportCurrentExtensionRuntime().catch((error) => {
			console.warn("[fuzzy] 拡張機能の実行情報をnative-hostへ保存できませんでした", error);
		});
	};

	browser.runtime.onInstalled.addListener(startNotificationMonitoring);
	browser.runtime.onStartup.addListener(startNotificationMonitoring);
	browser.alarms.onAlarm.addListener((alarm) => {
		if (alarm.name === SYNC_CHECK_ALARM) void checkLatestSyncEvent();
		if (alarm.name === deadlineNotificationMonitor.alarmName) {
			void deadlineNotificationMonitor.check();
		}
	});
	startNotificationMonitoring();

	browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
		if (isRuleManagementRequestMessage(message)) {
			void respondToRuleManagementRequest(getClient(), message).then(sendResponse);
			return true;
		}
		if (!isFuzzyApiRequestMessage(message)) return false;

		void respondToApiRequest(getClient(), message, sender.tab?.url ?? sender.url ?? "").then(
			sendResponse,
		);
		return true; // sendResponse を非同期に呼ぶため、メッセージチャネルを維持する
	});
});

async function respondToApiRequest(
	clientPromise: Promise<FuzzyApiClient>,
	message: FuzzyApiRequestMessage,
	senderUrl = "",
): Promise<FuzzyApiResponseMessage> {
	try {
		const client = await clientPromise;
		const data =
			message.method === "saveFiles"
				? await saveMoodleFilesFromBackground(
						client,
						message.request as MoodleSaveFilesRequest,
						pageOrigin(senderUrl),
					)
				: await callBackgroundApi(client, message);
		return { ok: true, data, mode: client.mode };
	} catch (error) {
		return {
			ok: false,
			error: toBackgroundApiError(error),
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
