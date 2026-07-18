import type { FuzzyApiClient } from "@fuzzy/shared";
import {
	DEADLINE_NOTIFICATION_WINDOW_MS,
	deadlineNotificationCandidates,
	dispatchDeadlineNotifications,
} from "./deadlineNotifications";

const DEADLINE_CHECK_ALARM = "fuzzy-check-deadline-notifications";
const DEADLINE_CHECK_INTERVAL_MINUTES = 1;
const DEADLINE_LAST_CHECKED_KEY_PREFIX = "fuzzy-deadline-last-checked";

export interface DeadlineNotificationMonitor {
	readonly alarmName: string;
	check(): Promise<void>;
	start(): void;
}

export function createDeadlineNotificationMonitor(
	getClient: () => Promise<FuzzyApiClient>,
): DeadlineNotificationMonitor {
	let checkPromise: Promise<void> | null = null;

	const check = (): Promise<void> => {
		if (checkPromise) return checkPromise;
		checkPromise = (async () => {
			try {
				await notifyDueDeadlines(await getClient());
			} catch (error) {
				console.warn("[fuzzy] 締切通知の確認に失敗しました", error);
			} finally {
				checkPromise = null;
			}
		})();
		return checkPromise;
	};

	const start = (): void => {
		browser.alarms.create(DEADLINE_CHECK_ALARM, {
			periodInMinutes: DEADLINE_CHECK_INTERVAL_MINUTES,
		});
		void check();
	};

	return { alarmName: DEADLINE_CHECK_ALARM, check, start };
}

async function notifyDueDeadlines(client: FuzzyApiClient): Promise<void> {
	const checkedAt = Date.now();
	const [assignments, rules] = await Promise.all([
		client.getDeadlines({ includePast: false }),
		client.getNotificationRules(),
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
