import type { Assignment, NotificationRule } from "@fuzzy/shared";

export interface DeadlineNotificationCandidate {
	assignment: Assignment;
	rule: NotificationRule;
	dueAt: number;
	notifyAt: number;
}

/** 初回確認時だけ、直前の通知を拾うために使う既定の確認幅。 */
export const DEADLINE_NOTIFICATION_WINDOW_MS = 2 * 60 * 1000;

export function deadlineNotificationCandidates(
	assignments: Assignment[],
	rules: NotificationRule[],
	now = Date.now(),
	lastCheckedAt = now - DEADLINE_NOTIFICATION_WINDOW_MS,
): DeadlineNotificationCandidate[] {
	const enabledRules = rules.filter((rule) => rule.enabled && rule.offsetMinutes >= 0);
	const latestCandidateByAssignment = new Map<number, DeadlineNotificationCandidate>();

	for (const assignment of assignments) {
		if (assignment.submitted || !assignment.dueAt) continue;
		const dueAt = Date.parse(assignment.dueAt);
		if (Number.isNaN(dueAt) || dueAt <= now) continue;

		for (const rule of enabledRules) {
			const notifyAt = dueAt - rule.offsetMinutes * 60 * 1000;
			if (notifyAt > now || notifyAt <= lastCheckedAt) continue;

			// ブラウザを長く閉じて複数タイミングを通過した場合は、同じ課題の通知を
			// 一度に並べず、現在に最も近いタイミングだけを届ける。
			const previous = latestCandidateByAssignment.get(assignment.id);
			if (!previous || notifyAt > previous.notifyAt) {
				latestCandidateByAssignment.set(assignment.id, { assignment, rule, dueAt, notifyAt });
			}
		}
	}

	return [...latestCandidateByAssignment.values()];
}

export function deadlineNotificationStorageKey(
	mode: string,
	candidate: DeadlineNotificationCandidate,
): string {
	return [
		"fuzzy-deadline-notified",
		mode,
		candidate.assignment.id,
		candidate.rule.id,
		candidate.dueAt,
	].join(":");
}

export interface DeadlineNotificationDelivery {
	isDelivered(storageKey: string): Promise<boolean>;
	deliver(candidate: DeadlineNotificationCandidate): Promise<void>;
	markDelivered(storageKey: string): Promise<void>;
}

/** 通知済み判定・通知・記録の順序を一か所にまとめ、重複通知を防ぐ。 */
export async function dispatchDeadlineNotifications(
	mode: string,
	candidates: DeadlineNotificationCandidate[],
	delivery: DeadlineNotificationDelivery,
): Promise<number> {
	let deliveredCount = 0;
	for (const candidate of candidates) {
		const storageKey = deadlineNotificationStorageKey(mode, candidate);
		if (await delivery.isDelivered(storageKey)) continue;
		await delivery.deliver(candidate);
		await delivery.markDelivered(storageKey);
		deliveredCount += 1;
	}
	return deliveredCount;
}
