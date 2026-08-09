import { describe, expect, test } from "bun:test";
import type { CourseDashboardEntry } from "@fuzzy/shared";
import {
	courseGroupLabel,
	groupCourses,
	normalizeCourseTerm,
} from "../../apps/extension/src/entrypoints/content/courseHierarchy";

function course(
	courseId: number,
	academicYear: number | null,
	term: string | null,
): CourseDashboardEntry {
	return {
		courseId,
		courseName: `授業${courseId}`,
		academicYear,
		term,
		fileCount: 0,
		violationCount: 0,
		nextDueAt: null,
	};
}

describe("courseHierarchy", () => {
	test("クォーターを年度グループから除く", () => {
		expect(normalizeCourseTerm("2026年度 2Q")).toBe("");
		expect(courseGroupLabel(course(1, 2026, "2Q"))).toBe("2026年度");
	});

	test("年度付きと年度なしの3年前期を同じグループにする", () => {
		const groups = groupCourses([course(1, 2026, "2026年度 3年前期"), course(2, null, "3年前期")]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.label).toBe("3年前期");
		expect(groups[0]?.courses).toHaveLength(2);
	});
});
