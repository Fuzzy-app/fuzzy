import { describe, expect, test } from "bun:test";
import { MOODLE_HTTPS_MATCH_PATTERNS } from "../../apps/extension/moodleSite";
import {
	type SyncNavigationBrowser,
	createDeadlineScreenNavigation,
	createSyncNotificationId,
	isDeadlineScreenNavigation,
	navigateFromSyncNotification,
	parseSyncNotificationId,
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

	test("既存タブが処理した場合だけ保留中の遷移を消す", async () => {
		const operations: unknown[] = [];
		const browserApi = {
			storage: {
				local: {
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
