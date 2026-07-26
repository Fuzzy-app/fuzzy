import { describe, expect, test } from "bun:test";
import type { Assignment, FuzzyApiClient, NotificationRule } from "@fuzzy/shared";
import { createDeadlineNotificationMonitor } from "../../apps/extension/src/lib/notifications/deadlineNotificationMonitor";
import {
	deadlineNotificationCandidates,
	deadlineNotificationStorageKey,
	dispatchDeadlineNotifications,
} from "../../apps/extension/src/lib/notifications/deadlineNotifications";

const now = Date.parse("2026-07-14T09:00:00.000Z");
const assignment: Assignment = {
	id: 7,
	courseId: 1,
	courseName: "アプリ演習",
	title: "レポート",
	source: "moodle_dashboard",
	dueAt: "2026-07-15T09:00:00.000Z",
	dueAtStatus: "normal",
	submissionMode: "moodle_auto",
	submitted: false,
};
const rules: NotificationRule[] = [
	{ id: 1, offsetMinutes: 1440, label: "1日前", enabled: true },
	{ id: 2, offsetMinutes: 60, label: "1時間前", enabled: false },
];

describe("締切通知判定", () => {
	test("mockフォールバックのサンプルから実通知を生成しない", async () => {
		let dataRead = false;
		const client = {
			mode: "mock",
			getDeadlines: async () => {
				dataRead = true;
				throw new Error("サンプル締切を通知判定へ渡してはいけません");
			},
		} as unknown as FuzzyApiClient;
		const monitor = createDeadlineNotificationMonitor(async () => client);

		await monitor.check();
		expect(dataRead).toBe(false);
	});

	test("認証済みMoodleタブがない間はhostクライアントを取得しない", async () => {
		let clientRequested = false;
		const monitor = createDeadlineNotificationMonitor(
			async () => {
				clientRequested = true;
				throw new Error("Moodleタブがない間は接続しない");
			},
			{ shouldCheck: () => false },
		);

		await monitor.check();
		expect(clientRequested).toBe(false);
	});

	test("有効な通知タイミングに達した未提出課題だけを返す", () => {
		const result = deadlineNotificationCandidates([assignment], rules, now);
		expect(result).toHaveLength(1);
		expect(result[0]?.rule.label).toBe("1日前");
	});

	test("提出済み・無効ルール・判定時刻外は通知しない", () => {
		expect(
			deadlineNotificationCandidates([{ ...assignment, submitted: true }], rules, now),
		).toHaveLength(0);
		expect(deadlineNotificationCandidates([assignment], rules, now + 3 * 60 * 1000)).toHaveLength(
			0,
		);
	});

	test("要確認の期限は誤通知を避けるため通知しない", () => {
		expect(
			deadlineNotificationCandidates([{ ...assignment, dueAtStatus: "needs_review" }], rules, now),
		).toHaveLength(0);
	});

	test("ブラウザ再開が遅れても前回確認後の通知を拾う", () => {
		const fiveMinutesLater = now + 5 * 60 * 1000;
		const result = deadlineNotificationCandidates(
			[assignment],
			rules,
			fiveMinutesLater,
			now - 60 * 1000,
		);
		expect(result).toHaveLength(1);
		expect(result[0]?.notifyAt).toBe(now);
	});

	test("複数タイミングを通過していた場合は課題ごとに最新の1件だけを返す", () => {
		const dueAt = Date.parse(assignment.dueAt ?? "");
		const twelveHoursBeforeDue = dueAt - 12 * 60 * 60 * 1000;
		const multipleRules: NotificationRule[] = [
			{ id: 1, offsetMinutes: 4320, label: "3日前", enabled: true },
			{ id: 2, offsetMinutes: 1440, label: "1日前", enabled: true },
		];
		const result = deadlineNotificationCandidates(
			[assignment],
			multipleRules,
			twelveHoursBeforeDue,
			dueAt - 4 * 24 * 60 * 60 * 1000,
		);
		expect(result).toHaveLength(1);
		expect(result[0]?.rule.label).toBe("1日前");
	});

	test("同じ課題・ルール・期限に対して安定した重複防止キーを作る", () => {
		const candidate = deadlineNotificationCandidates([assignment], rules, now)[0];
		expect(candidate && deadlineNotificationStorageKey("mock", candidate)).toBe(
			`fuzzy-deadline-notified:mock:7:1:${Date.parse(assignment.dueAt ?? "")}`,
		);
	});

	test("通知成功後に記録し、同じ候補を再通知しない", async () => {
		const candidates = deadlineNotificationCandidates([assignment], rules, now);
		const deliveredKeys = new Set<string>();
		let notificationCount = 0;
		const delivery = {
			isDelivered: async (storageKey: string) => deliveredKeys.has(storageKey),
			deliver: async () => {
				notificationCount += 1;
			},
			markDelivered: async (storageKey: string) => {
				deliveredKeys.add(storageKey);
			},
		};

		expect(await dispatchDeadlineNotifications("mock", candidates, delivery)).toBe(1);
		expect(await dispatchDeadlineNotifications("mock", candidates, delivery)).toBe(0);
		expect(notificationCount).toBe(1);
	});
});
