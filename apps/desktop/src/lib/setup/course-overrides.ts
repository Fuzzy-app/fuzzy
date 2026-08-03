import type { CourseOverride, PatternCandidate } from "./types";

const maxCourseOverrideCandidates = 3;

function isCourseName(value: string | undefined): value is string {
	return Boolean(value);
}

export function createSavedCourseOverrides(
	courseNames: readonly string[] | SavedCourseOverrideInput[],
): CourseOverride[] {
	return Array.from(
		new Map(
			courseNames
				.map((item) => {
					const value = typeof item === "string" ? item : item.courseName;
					return [value.trim(), typeof item === "string" ? "override" : item.mode] as const;
				})
				.filter(([courseName]) => Boolean(courseName)),
		),
	).map(([courseName, mode], index) => ({
		id: `saved-course-override-${index + 1}`,
		courseName,
		description: "保存済みの授業別設定です。",
		enabled: mode === "override",
		mode,
	}));
}

type SavedCourseOverrideInput = {
	courseName: string;
	mode: "common" | "override" | "unmanaged";
};

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
		new Set([...currentOverrides.map(({ courseName }) => courseName), ...suggestedCourseNames]),
	);

	return courseNames.map((courseName, index) => ({
		id: `course-override-${index + 1}`,
		courseName,
		description: "この科目だけ初期ルールから外す候補として保持します。",
		enabled:
			currentOverrides.find((override) => override.courseName === courseName)?.enabled ?? false,
		mode: currentOverrides.find((override) => override.courseName === courseName)?.mode ?? "common",
	}));
}
