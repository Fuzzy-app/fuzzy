import type { Assignment, AssignmentChange, DataSyncEvent } from "@fuzzy/shared";

// API取得用のDeadlineFilterと区別するため、画面内フィルタには専用名を使う。
export type DeadlineViewFilter = "all" | "upcoming" | "overdue" | "review";

function getNow(): number {
	return Date.now();
}

export function parseDueAt(dueAt: string | null): number | null {
	if (!dueAt) return null;
	const time = Date.parse(dueAt);
	return Number.isNaN(time) ? null : time;
}

// 和歌山大学のセメスター区分。締切画面では年間を前期（4〜9月）と後期（10〜3月）に分ける。
type Semester = "first" | "second";

function semesterOf(time: number): Semester {
	const month = new Date(time).getMonth() + 1;
	return month >= 4 && month < 10 ? "first" : "second";
}

function semesterLabel(semester: Semester): string {
	return semester === "first" ? "前期" : "後期";
}

export function isNeedsReview(assignment: Assignment): boolean {
	return (
		assignment.dueAtStatus === "needs_review" ||
		(assignment.dueAt !== null && parseDueAt(assignment.dueAt) === null)
	);
}

export function isOverdue(assignment: Assignment): boolean {
	const dueTime = parseDueAt(assignment.dueAt);
	return Boolean(dueTime !== null && !assignment.submitted && dueTime < getNow());
}

export function isUpcoming(assignment: Assignment): boolean {
	const dueTime = parseDueAt(assignment.dueAt);
	return (
		!assignment.submitted &&
		(assignment.dueAt === null || dueTime !== null) &&
		(dueTime === null || dueTime >= getNow()) &&
		!isNeedsReview(assignment)
	);
}

const dueAtFormatter = new Intl.DateTimeFormat("ja-JP", {
	month: "numeric",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
});

const cacheDateFormatter = new Intl.DateTimeFormat("ja-JP", {
	month: "numeric",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
});

export function formatCacheDate(cachedAt: string): string {
	const time = Date.parse(cachedAt);
	return Number.isNaN(time) ? "日時不明" : cacheDateFormatter.format(new Date(time));
}

export function formatDate(dueAt: string | null): string {
	if (!dueAt) return "期限未設定";
	const time = parseDueAt(dueAt);
	if (time === null) return `${semesterLabel(semesterOf(getNow()))}中・締切日を確認`;
	return dueAtFormatter.format(new Date(time));
}

export function submissionLabel(assignment: Assignment): string {
	switch (assignment.submissionMode) {
		case "moodle_auto":
			return "Moodle提出";
		case "manual":
			return "手動提出";
		case "notify_only":
			return "通知のみ";
		default:
			return "確認中";
	}
}

export function sourceLabel(assignment: Assignment): string {
	switch (assignment.source) {
		case "moodle_dashboard":
			return "Moodleダッシュボード";
		case "moodle_text":
			return "Moodle本文";
		case "file_content":
			return "資料本文";
	}
}

export function deadlineFilterLabel(filter: DeadlineViewFilter): string {
	switch (filter) {
		case "upcoming":
			return "今後";
		case "overdue":
			return "期限切れ";
		case "review":
			return "締切日を確認";
		default:
			return "すべて";
	}
}

const syncDateFormatter = new Intl.DateTimeFormat("ja-JP", {
	month: "numeric",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
});

export function formatSyncDate(syncedAt: string): string {
	const time = Date.parse(syncedAt);
	if (Number.isNaN(time)) return "取得日時を確認してください";
	return syncDateFormatter.format(new Date(time));
}

export function syncTriggerLabel(trigger: DataSyncEvent["trigger"]): string {
	return trigger === "manual" ? "手動取得" : "自動取得";
}

export function assignmentChangeFieldLabel(field: AssignmentChange["field"]): string {
	switch (field) {
		case "dueAt":
			return "期限";
		case "title":
			return "課題名";
		case "submissionMode":
			return "提出方法";
		case "dueAtStatus":
			return "期限判定";
		case "submitted":
			return "提出状況";
	}
}

export function assignmentChangeValueLabel(
	field: AssignmentChange["field"],
	value: string | null,
): string {
	if (value === null || value === "") return "未設定";
	if (field === "dueAt") return formatDate(value);
	if (field === "dueAtStatus") return value === "needs_review" ? "締切日を確認" : "通常";
	if (field === "submitted") return value === "true" ? "提出済み" : "未提出";
	if (field === "submissionMode") {
		switch (value) {
			case "moodle_auto":
				return "Moodle提出";
			case "manual":
				return "手動提出";
			case "notify_only":
				return "通知のみ";
			default:
				return "確認中";
		}
	}
	return value;
}

export function syncChangeTotal(event: DataSyncEvent): number {
	return event.newAssignmentCount + event.changedAssignmentCount + event.removedAssignmentCount;
}
