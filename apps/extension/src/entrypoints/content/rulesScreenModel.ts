import {
	type CourseDashboardEntry,
	type CourseRuleOverride,
	RULE_PRESETS,
	type RulePreviewValues,
	createRulePreviewValues,
	previewRulePattern,
	validateCourseRuleOverride,
	validateRulePattern,
} from "@fuzzy/shared";

export interface CourseRuleDraft {
	courseName: string;
	splitBySection: boolean;
	patternTemplate: string;
	note: string;
}

export function createCourseRuleDraft(override: CourseRuleOverride): CourseRuleDraft {
	return {
		courseName: override.courseName,
		splitBySection: override.splitBySection,
		patternTemplate: override.patternTemplate ?? "",
		note: override.note ?? "",
	};
}

export function isSameCourseRuleDraft(
	draft: CourseRuleDraft,
	override: CourseRuleOverride,
): boolean {
	return (
		draft.courseName.trim() === override.courseName &&
		draft.splitBySection === override.splitBySection &&
		(draft.patternTemplate.trim() || null) === override.patternTemplate &&
		(draft.note.trim() || null) === override.note
	);
}

export function effectivePattern(draft: CourseRuleDraft, globalPatternTemplate: string): string {
	return draft.patternTemplate.trim() || globalPatternTemplate;
}

export function validateCourseRuleDraft(
	draft: CourseRuleDraft,
	globalPatternTemplate: string,
): string | null {
	return validateCourseRuleOverride(
		{
			splitBySection: draft.splitBySection,
			patternTemplate: draft.patternTemplate.trim() || null,
			note: draft.note.trim() || null,
		},
		globalPatternTemplate,
	);
}

export function createScreenPreviewValues(now = new Date()): RulePreviewValues {
	return createRulePreviewValues(now);
}

export function previewPattern(
	patternTemplate: string,
	values: RulePreviewValues,
	courseName = values.course,
): string {
	return previewRulePattern(patternTemplate, { ...values, course: courseName });
}

export function patternLabel(patternTemplate: string): string {
	return (
		RULE_PRESETS.find((preset) => preset.template === patternTemplate)?.name ?? "カスタムルール"
	);
}

export function getAvailableCourses(
	courses: readonly CourseDashboardEntry[],
	overrides: readonly CourseRuleOverride[],
): CourseDashboardEntry[] {
	const overriddenCourseIds = new Set(overrides.map((override) => override.courseId));
	return courses.filter((course) => !overriddenCourseIds.has(course.courseId));
}

export function dedupeCourses(courses: readonly CourseDashboardEntry[]): CourseDashboardEntry[] {
	const byId = new Map<number, CourseDashboardEntry>();
	for (const course of courses) byId.set(course.courseId, course);
	return [...byId.values()].sort((left, right) => left.courseId - right.courseId);
}

export { validateRulePattern };
