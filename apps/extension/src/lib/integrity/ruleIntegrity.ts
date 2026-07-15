import type { DuplicateGroup, RuleViolation } from "@fuzzy/shared";

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
	violations: readonly RuleViolation[],
	duplicateGroups: readonly DuplicateGroup[],
): RuleIntegritySummary {
	const courseNames = new Set(
		violations
			.map((violation) => violation.courseName?.trim())
			.filter((courseName): courseName is string => Boolean(courseName)),
	);
	const duplicateFileIds = new Set(
		duplicateGroups.flatMap((group) => group.members.map((member) => member.fileId)),
	);

	return {
		violationCount: violations.length,
		affectedCourseCount: courseNames.size,
		duplicateGroupCount: duplicateGroups.length,
		duplicateFileCount: duplicateFileIds.size,
	};
}

export function duplicateMethodLabel(method: DuplicateGroup["method"]): string {
	return method === "exact" ? "完全一致" : "類似";
}
