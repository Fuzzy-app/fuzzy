import {
	type CheckSimilarFilesRequest,
	type DataSyncEvent,
	type ExtractZipRequest,
	type FuzzyApiClient,
	type NotificationRuleInput,
	type SaveFilesRequest,
	type SuggestSavePathRequest,
	createApiClient,
} from "@fuzzy/shared";
import {
	type FuzzyApiRequestMessage,
	type FuzzyApiResponseMessage,
	isFuzzyApiRequestMessage,
} from "../lib/api/backgroundApi";
import { createDeadlineNotificationMonitor } from "../lib/notifications/deadlineNotificationMonitor";
import {
	isRuleManagementRequestMessage,
	respondToRuleManagementRequest,
} from "../lib/rules/backgroundApi";
import { reportCurrentExtensionRuntime } from "../lib/runtime/extensionRuntime";

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
		message:
			total > 0 ? `変更が${total}件あります。締切ハブで確認できます。` : "変更はありません。",
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

	browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
		if (isRuleManagementRequestMessage(message)) {
			void respondToRuleManagementRequest(getClient(), message).then(sendResponse);
			return true;
		}
		if (!isFuzzyApiRequestMessage(message)) return false;

		void respondToApiRequest(getClient(), message).then(sendResponse);
		return true; // sendResponse を非同期に呼ぶため、メッセージチャネルを維持する
	});
});

async function respondToApiRequest(
	clientPromise: Promise<FuzzyApiClient>,
	message: FuzzyApiRequestMessage,
): Promise<FuzzyApiResponseMessage> {
	try {
		const client = await clientPromise;
		const data = await callBackgroundApi(client, message);
		return { ok: true, data, mode: client.mode };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : "APIの呼び出しに失敗しました",
		};
	}
}

// リクエスト本文はメッセージ境界を越えるため実行時には型情報が失われている。
// メソッド名で分岐し、各APIの想定型として渡す（内容の検証はnative-host側の契約に委ねる）。
async function callBackgroundApi(
	client: FuzzyApiClient,
	message: FuzzyApiRequestMessage,
): Promise<unknown> {
	switch (message.method) {
		case "suggestSavePath":
			return client.suggestSavePath(message.request as SuggestSavePathRequest);
		case "checkSimilarFiles":
			return client.checkSimilarFiles(message.request as CheckSimilarFilesRequest);
		case "saveFiles":
			return client.saveFiles(message.request as SaveFilesRequest);
		case "extractZip":
			return client.extractZip(message.request as ExtractZipRequest);
		case "getNotificationRules":
			return client.getNotificationRules();
		case "updateNotificationRules":
			return client.updateNotificationRules(message.request as NotificationRuleInput[]);
	}
}
