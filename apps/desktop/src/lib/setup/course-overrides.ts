import type { CourseOverride, PatternCandidate } from "./types";

const maxCourseOverrideCandidates = 3;

function isCourseName(value: string | undefined): value is string {
	return Boolean(value);
}

export function createSavedCourseOverrides(courseNames: readonly string[]): CourseOverride[] {
	return Array.from(
		new Set(courseNames.map((courseName) => courseName.trim()).filter(Boolean)),
	).map((courseName, index) => ({
		id: `saved-course-override-${index + 1}`,
		courseName,
		description: "保存済みの授業別設定です。",
		enabled: true,
	}));
}

export function createCourseOverrides(
	candidate: PatternCandidate | null,
	currentOverrides: CourseOverride[] = [],
): CourseOverride[] {
	if (!candidate || candidate.courseSegmentIndex === null) {
		return [];
	}

	const { courseSegmentIndex } = candidate;
	const suggestedCourseNames = Array.from(
		new Set(
			candidate.folders
				.map((folder) => folder.split(/[\\/]/)[courseSegmentIndex]?.trim())
				.filter(isCourseName),
		),
	).slice(0, maxCourseOverrideCandidates);
	const courseNames = Array.from(
		new Set([
			...currentOverrides.filter(({ enabled }) => enabled).map(({ courseName }) => courseName),
			...suggestedCourseNames,
		]),
	);

	return courseNames.map((courseName, index) => ({
		id: `course-override-${index + 1}`,
		courseName,
		description: "この科目だけ初期ルールから外す候補として保持します。",
		enabled:
			currentOverrides.find((override) => override.courseName === courseName)?.enabled ?? false,
	}));
}
