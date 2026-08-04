import { describe, expect, test } from "bun:test";
import { MOODLE_HTTPS_MATCH_PATTERNS } from "../../apps/extension/moodleSite";
import {
	LAST_MOODLE_HOME_URL_KEY,
	type SyncNavigationBrowser,
	createDeadlineScreenNavigation,
	createSyncNotificationId,
	isDeadlineScreenNavigation,
	navigateFromSyncNotification,
	parseSyncNotificationId,
	rememberMoodleHomeUrl,
	supportedMoodleHomeUrl,
	syncEventChangeCursor,
} from "../../apps/extension/src/lib/notifications/syncNotificationNavigation";

describe("同期通知から課題・締切への遷移", () => {
	test("通知IDへ同期イベントを保持し、クリック時に復元する", () => {
		const notificationId = createSyncNotificationId("native", 42);
		expect(notificationId).toBe("fuzzy-sync-native-42");
		expect(parseSyncNotificationId(notificationId)).toEqual({
			mode: "native",
			syncEventId: 42,
		});
		expect(parseSyncNotificationId("fuzzy-sync-native-0")).toBeNull();
		expect(parseSyncNotificationId("fuzzy-deadline-42")).toBeNull();
	});

	test("通知対象の同期を含む変更カーソルを画面へ渡す", () => {
		const navigation = createDeadlineScreenNavigation(42);
		expect(isDeadlineScreenNavigation(navigation)).toBe(true);
		expect(syncEventChangeCursor(navigation.syncEventId)).toBe(41);
		expect(
			isDeadlineScreenNavigation({
				...navigation,
				syncEventId: Number.NaN,
			}),
		).toBe(false);
	});

	test("Moodleタブがない場合は遷移を保持してMoodleを開く", async () => {
		const operations: unknown[] = [];
		const browserApi = {
			storage: {
				local: {
					get: async () => ({}),
					set: async (items) => {
						operations.push(["set", items]);
					},
					remove: async (key) => {
						operations.push(["remove", key]);
					},
				},
			},
			tabs: {
				query: async () => [],
				create: async (properties) => {
					operations.push(["create", properties]);
				},
				update: async () => undefined,
				sendMessage: async () => undefined,
			},
		} satisfies SyncNavigationBrowser;

		await expect(navigateFromSyncNotification(browserApi, "fuzzy-sync-native-42")).resolves.toBe(
			true,
		);
		expect(operations).toEqual([
			[
				"set",
				{
					"fuzzy-pending-sync-screen-navigation": {
						type: "fuzzy:open-screen",
						screen: "deadlines",
						syncEventId: 42,
					},
				},
			],
			["create", { url: "https://moodle.wakayama-u.ac.jp/", active: true }],
		]);
	});

	test("Moodleタブがない場合は直近の同期元QAサイトを開く", async () => {
		const createdUrls: string[] = [];
		const browserApi = {
			storage: {
				local: {
					get: async () => ({
						[LAST_MOODLE_HOME_URL_KEY]: "https://fuzzy-qa-2026.moodlecloud.com/",
					}),
					set: async () => undefined,
					remove: async () => undefined,
				},
			},
			tabs: {
				query: async () => [],
				create: async ({ url }) => {
					createdUrls.push(url);
				},
				update: async () => undefined,
				sendMessage: async () => undefined,
			},
		} satisfies SyncNavigationBrowser;

		await navigateFromSyncNotification(browserApi, "fuzzy-sync-native-42");
		expect(createdUrls).toEqual(["https://fuzzy-qa-2026.moodlecloud.com/"]);
	});

	test("複数のMoodleタブがある場合は直近の同期元サイトを優先する", async () => {
		const activatedTabIds: number[] = [];
		const browserApi = {
			storage: {
				local: {
					get: async () => ({
						[LAST_MOODLE_HOME_URL_KEY]: "https://fuzzy-qa-2026.moodlecloud.com/",
					}),
					set: async () => undefined,
					remove: async () => undefined,
				},
			},
			tabs: {
				query: async () => [
					{ id: 1, active: true, url: "https://moodle2026.wakayama-u.ac.jp/" },
					{
						id: 2,
						active: false,
						url: "https://fuzzy-qa-2026.moodlecloud.com/course/view.php?id=136",
					},
				],
				create: async () => undefined,
				update: async (tabId) => {
					activatedTabIds.push(tabId);
				},
				sendMessage: async () => ({ handled: true }),
			},
		} satisfies SyncNavigationBrowser;

		await navigateFromSyncNotification(browserApi, "fuzzy-sync-native-42");
		expect(activatedTabIds).toEqual([2]);
	});

	test("同期元として正確な対応MoodleのHTTPS originだけを記録する", async () => {
		const writes: Record<string, unknown>[] = [];
		const storage = {
			set: async (items: Record<string, unknown>) => {
				writes.push(items);
			},
		};

		await expect(
			rememberMoodleHomeUrl(
				storage,
				"https://fuzzy-qa-2026.moodlecloud.com/mod/assign/view.php?id=701",
			),
		).resolves.toBe(true);
		expect(writes).toEqual([
			{ [LAST_MOODLE_HOME_URL_KEY]: "https://fuzzy-qa-2026.moodlecloud.com/" },
		]);
		expect(supportedMoodleHomeUrl("https://moodle2026.wakayama-u.ac.jp/course/view.php")).toBe(
			"https://moodle2026.wakayama-u.ac.jp/",
		);

		for (const value of [
			"http://fuzzy-qa-2026.moodlecloud.com/course/view.php?id=1",
			"https://fuzzy-qa-2026.moodlecloud.com.evil.example/course/view.php?id=1",
			"https://user@fuzzy-qa-2026.moodlecloud.com/course/view.php?id=1",
			"https://fuzzy-qa-2026.moodlecloud.com:444/course/view.php?id=1",
		]) {
			await expect(rememberMoodleHomeUrl(storage, value)).resolves.toBe(false);
		}
		expect(writes).toHaveLength(1);
	});

	test("既存タブが処理した場合だけ保留中の遷移を消す", async () => {
		const operations: unknown[] = [];
		const browserApi = {
			storage: {
				local: {
					get: async () => ({}),
					set: async () => undefined,
					remove: async (key) => {
						operations.push(["remove", key]);
					},
				},
			},
			tabs: {
				query: async (query) => {
					operations.push(["query", query]);
					return [{ id: 7, active: true }];
				},
				create: async () => undefined,
				update: async (tabId, properties) => {
					operations.push(["update", tabId, properties]);
				},
				sendMessage: async (tabId, message) => {
					operations.push(["message", tabId, message]);
					return { handled: true };
				},
			},
		} satisfies SyncNavigationBrowser;

		await navigateFromSyncNotification(browserApi, "fuzzy-sync-native-9");
		expect(operations).toEqual([
			["query", { url: MOODLE_HTTPS_MATCH_PATTERNS }],
			["update", 7, { active: true }],
			["message", 7, { type: "fuzzy:open-screen", screen: "deadlines", syncEventId: 9 }],
			["remove", "fuzzy-pending-sync-screen-navigation"],
		]);
	});
});
