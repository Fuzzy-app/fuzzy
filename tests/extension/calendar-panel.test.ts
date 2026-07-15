import { describe, expect, test } from "bun:test";
import type { Assignment, NotificationRule } from "@fuzzy/shared";
import { parseHTML } from "linkedom";
import { createCalendarPanelController } from "../../apps/extension/src/entrypoints/content/calendarPanel";

const assignment: Assignment = {
	id: 7,
	courseId: 1,
	courseName: "アプリ演習",
	title: "レポート",
	source: "moodle_dashboard",
	dueAt: "2026-07-20T09:00:00.000Z",
	dueAtStatus: "normal",
	submissionMode: "moodle_auto",
	submitted: false,
};

const rules: NotificationRule[] = [
	{ id: 1, offsetMinutes: 1440, label: "1日前", enabled: true },
	{ id: 2, offsetMinutes: 540, label: "9時間前", enabled: false },
];

describe("カレンダー・通知設定パネル", () => {
	test("通知設定を読み込み、モックの更新をAPIへ渡す", async () => {
		const { document, window } = parseHTML("<html><head></head><body></body></html>");
		Object.assign(globalThis, {
			document,
			window,
			HTMLElement: window.HTMLElement,
			HTMLInputElement: window.HTMLInputElement,
		});
		const updates: NotificationRule[][] = [];
		const api = {
			mode: "mock" as const,
			getNotificationRules: async () => rules,
			updateNotificationRules: async (nextRules: NotificationRule[]) => {
				updates.push(nextRules);
				return { ok: true };
			},
		};
		const controller = createCalendarPanelController({
			api,
			onChange: () => undefined,
			now: () => Date.parse("2026-07-14T00:00:00.000Z"),
		});

		controller.ensureNotificationRulesLoaded();
		await nextTask();
		const panel = controller.render([assignment]);
		document.body.append(panel);
		expect(panel.textContent).toContain("9時間前");
		expect(panel.textContent).toContain("再起動後にリセット");

		const checkbox = panel.querySelector<HTMLInputElement>('input[aria-label="1日前の通知"]');
		expect(checkbox).not.toBeNull();
		if (!checkbox) return;
		checkbox.checked = false;
		checkbox.dispatchEvent(new window.Event("change"));
		await nextTask();

		expect(updates).toHaveLength(1);
		expect(updates[0]?.find((rule) => rule.id === 1)?.enabled).toBe(false);
	});

	test("対象課題だけをICSとしてダウンロード処理へ渡す", async () => {
		const { document, window } = parseHTML("<html><head></head><body></body></html>");
		Object.assign(globalThis, {
			document,
			window,
			HTMLElement: window.HTMLElement,
		});
		let downloadedContent = "";
		let downloadedFileName = "";
		const controller = createCalendarPanelController({
			api: {
				mode: "native" as const,
				getNotificationRules: async () => rules,
				updateNotificationRules: async () => ({ ok: true }),
			},
			onChange: () => undefined,
			now: () => Date.parse("2026-07-14T00:00:00.000Z"),
			download: (content, fileName) => {
				downloadedContent = content;
				downloadedFileName = fileName;
			},
		});
		const needsReview = { ...assignment, id: 8, dueAtStatus: "needs_review" as const };
		const panel = controller.render([assignment, needsReview]);
		document.body.append(panel);
		const button = panel.querySelector<HTMLButtonElement>(".fuzzy-calendar-button");
		expect(button?.disabled).toBe(false);
		button?.click();

		expect(downloadedFileName).toBe("fuzzy-deadlines-2026-07-14.ics");
		expect(downloadedContent).toContain("UID:fuzzy-assignment-7@fuzzy.local");
		expect(downloadedContent).not.toContain("UID:fuzzy-assignment-8@fuzzy.local");
	});
});

function nextTask(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}
