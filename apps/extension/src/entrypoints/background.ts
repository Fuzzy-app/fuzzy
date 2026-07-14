import {
	type CheckSimilarFilesRequest,
	type DataSyncEvent,
	type ExtractZipRequest,
	type FuzzyApiClient,
	type NotificationRule,
	type SaveFilesRequest,
	type SuggestSavePathRequest,
	createApiClient,
} from "@fuzzy/shared";
import {
	type FuzzyApiRequestMessage,
	type FuzzyApiResponseMessage,
	isFuzzyApiRequestMessage,
} from "../lib/api/backgroundApi";
import {
	DEADLINE_NOTIFICATION_WINDOW_MS,
	deadlineNotificationCandidates,
	dispatchDeadlineNotifications,
} from "../lib/notifications/deadlineNotifications";

const SYNC_CHECK_ALARM = "fuzzy-check-latest-sync-event";
const SYNC_NOTIFICATION_KEY_PREFIX = "fuzzy-last-notified-sync-event";
const SYNC_CHECK_INTERVAL_MINUTES = 1;
const DEADLINE_CHECK_ALARM = "fuzzy-check-deadline-notifications";
const DEADLINE_CHECK_INTERVAL_MINUTES = 1;
const MOCK_NOTIFICATION_RULES_STORAGE_KEY = "fuzzy-mock-notification-rules";
const DEADLINE_LAST_CHECKED_KEY_PREFIX = "fuzzy-deadline-last-checked";

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

async function getEffectiveNotificationRules(client: FuzzyApiClient): Promise<NotificationRule[]> {
	const apiRules = await client.getNotificationRules();
	if (client.mode !== "mock") return apiRules;

	const stored = await browser.storage.local.get(MOCK_NOTIFICATION_RULES_STORAGE_KEY);
	const storedRules = stored[MOCK_NOTIFICATION_RULES_STORAGE_KEY];
	if (Array.isArray(storedRules)) return storedRules as NotificationRule[];

	await browser.storage.local.set({ [MOCK_NOTIFICATION_RULES_STORAGE_KEY]: apiRules });
	return apiRules;
}

async function updateEffectiveNotificationRules(
	client: FuzzyApiClient,
	rules: NotificationRule[],
): Promise<{ ok: boolean }> {
	const result = await client.updateNotificationRules(rules);
	if (result.ok && client.mode === "mock") {
		await browser.storage.local.set({ [MOCK_NOTIFICATION_RULES_STORAGE_KEY]: rules });
	}
	return result;
}

async function notifyDueDeadlines(client: FuzzyApiClient): Promise<void> {
	const checkedAt = Date.now();
	const [assignments, rules] = await Promise.all([
		client.getDeadlines({ includePast: false }),
		getEffectiveNotificationRules(client),
	]);

	const lastCheckedKey = `${DEADLINE_LAST_CHECKED_KEY_PREFIX}:${client.mode}`;
	const lastCheckedRecord = await browser.storage.local.get(lastCheckedKey);
	const storedLastCheckedAt = lastCheckedRecord[lastCheckedKey];
	const lastCheckedAt =
		typeof storedLastCheckedAt === "number" &&
		Number.isFinite(storedLastCheckedAt) &&
		storedLastCheckedAt <= checkedAt
			? storedLastCheckedAt
			: checkedAt - DEADLINE_NOTIFICATION_WINDOW_MS;
	const candidates = deadlineNotificationCandidates(assignments, rules, checkedAt, lastCheckedAt);

	await dispatchDeadlineNotifications(client.mode, candidates, {
		isDelivered: async (storageKey) => {
			const stored = await browser.storage.local.get(storageKey);
			return Boolean(stored[storageKey]);
		},
		deliver: async (candidate) => {
			await browser.notifications.create(
				`fuzzy-deadline-${client.mode}-${candidate.assignment.id}-${candidate.rule.id}`,
				{
					type: "basic",
					iconUrl: browser.runtime.getURL("/icon/128.png"),
					title: `Fuzzy: 締切${candidate.rule.label}`,
					message: `${candidate.assignment.courseName}「${candidate.assignment.title}」の締切が近づいています。`,
				},
			);
		},
		markDelivered: async (storageKey) => {
			await browser.storage.local.set({ [storageKey]: true });
		},
	});
	// API取得や通知処理が失敗した場合はここへ到達しない。前回時刻を進めず、次回に再試行する。
	await browser.storage.local.set({ [lastCheckedKey]: checkedAt });
}

// Native Messaging接続（native-host疎通）はbackgroundに集約する（仕様書3.4節）。
// content script側は lib/api/backgroundApi.ts の BackgroundApiClient から
// runtimeメッセージでここへ委譲する。
export default defineBackground(() => {
	let clientPromise: Promise<FuzzyApiClient> | null = null;
	let deadlineCheckPromise: Promise<void> | null = null;
	const getClient = (): Promise<FuzzyApiClient> => {
		if (!clientPromise) clientPromise = createApiClient();
		return clientPromise;
	};

	const checkLatestSyncEvent = async () => {
		try {
			await notifyWhenSyncEventIsNew(await getClient());
		} catch (error) {
			console.warn("[fuzzy] 同期結果の通知確認に失敗しました", error);
		}
	};

	const checkDeadlineNotifications = () => {
		if (deadlineCheckPromise) return deadlineCheckPromise;
		deadlineCheckPromise = (async () => {
			try {
				await notifyDueDeadlines(await getClient());
			} catch (error) {
				console.warn("[fuzzy] 締切通知の確認に失敗しました", error);
			} finally {
				deadlineCheckPromise = null;
			}
		})();
		return deadlineCheckPromise;
	};

	const startSyncNotificationMonitoring = () => {
		browser.alarms.create(SYNC_CHECK_ALARM, {
			periodInMinutes: SYNC_CHECK_INTERVAL_MINUTES,
		});
		void checkLatestSyncEvent();
	};

	const startDeadlineNotificationMonitoring = () => {
		browser.alarms.create(DEADLINE_CHECK_ALARM, {
			periodInMinutes: DEADLINE_CHECK_INTERVAL_MINUTES,
		});
		void checkDeadlineNotifications();
	};

	const startNotificationMonitoring = () => {
		startSyncNotificationMonitoring();
		startDeadlineNotificationMonitoring();
	};

	browser.runtime.onInstalled.addListener(startNotificationMonitoring);
	browser.runtime.onStartup.addListener(startNotificationMonitoring);
	browser.alarms.onAlarm.addListener((alarm) => {
		if (alarm.name === SYNC_CHECK_ALARM) void checkLatestSyncEvent();
		if (alarm.name === DEADLINE_CHECK_ALARM) void checkDeadlineNotifications();
	});
	startNotificationMonitoring();

	browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
			return getEffectiveNotificationRules(client);
		case "updateNotificationRules":
			return updateEffectiveNotificationRules(client, message.request as NotificationRule[]);
	}
}
