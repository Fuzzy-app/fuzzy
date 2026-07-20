import type { DuplicateGroupListItem, RuleViolationListItem } from "@fuzzy/shared";

export interface RuleIntegritySummary {
	violationCount: number;
	affectedCourseCount: number;
	duplicateGroupCount: number;
	duplicateFileCount: number;
}

/**
 * 警告画面の集計値を作る。
 * 重複ファイル数は、同じfileIdが複数グループに含まれても1件として数える。
 */
export function summarizeRuleIntegrity(
	violations: readonly RuleViolationListItem[],
	duplicateGroups: readonly DuplicateGroupListItem[],
): RuleIntegritySummary {
	const courseIds = new Set(
		violations
			.map((violation) => violation.courseId)
			.filter((courseId): courseId is number => courseId !== null),
	);
	const duplicateFileIds = new Set(
		duplicateGroups.flatMap((group) => group.members.map((member) => member.fileId)),
	);

	return {
		violationCount: violations.length,
		affectedCourseCount: courseIds.size,
		duplicateGroupCount: duplicateGroups.length,
		duplicateFileCount: duplicateFileIds.size,
	};
}

export function duplicateMethodLabel(method: DuplicateGroupListItem["method"]): string {
	switch (method) {
		case "exact":
			return "完全一致";
		case "similar":
			return "類似";
	}
}
