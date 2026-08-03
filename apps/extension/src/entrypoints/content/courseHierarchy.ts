import type { CourseDashboardEntry } from "@fuzzy/shared";

export interface CourseGroup {
	key: string;
	label: string;
	courses: CourseDashboardEntry[];
}

export function courseGroupLabel(course: CourseDashboardEntry): string {
	const term = course.term?.trim() ?? "";
	const year = course.academicYear;
	if (term && year !== null && year !== undefined && !term.includes(String(year))) {
		return `${year}年度 ${term}`;
	}
	if (term) return term;
	if (year !== null && year !== undefined) return `${year}年度`;
	return "学期未設定";
}

export function groupCourses(courses: readonly CourseDashboardEntry[]): CourseGroup[] {
	const groups = new Map<string, CourseGroup>();
	for (const course of courses) {
		const label = courseGroupLabel(course);
		const key = `${course.academicYear ?? "unknown"}:${course.term ?? "unknown"}:${label}`;
		const group = groups.get(key) ?? { key, label, courses: [] };
		group.courses.push(course);
		groups.set(key, group);
	}
	return [...groups.values()].sort(compareCourseGroups);
}

function compareCourseGroups(left: CourseGroup, right: CourseGroup): number {
	const leftKey = courseGroupSortKey(left);
	const rightKey = courseGroupSortKey(right);
	for (let index = 0; index < leftKey.length; index += 1) {
		const leftValue = leftKey[index] ?? 0;
		const rightValue = rightKey[index] ?? 0;
		if (leftValue !== rightValue) return rightValue - leftValue;
	}
	return left.label.localeCompare(right.label, "ja");
}

/** 年度が明確なグループを先にし、同じ年度内では後期を先に表示する。 */
function courseGroupSortKey(group: CourseGroup): [number, number, number] {
	const academicYear = Math.max(
		...group.courses
			.map((course) => course.academicYear)
			.filter((year): year is number => typeof year === "number" && year >= 1900),
		0,
	);
	if (academicYear > 0) return [2, academicYear, termSortValue(group.label)];

	const grade = group.label.match(/([1-9])年/);
	if (grade) return [1, Number(grade[1]), termSortValue(group.label)];
	return [0, 0, termSortValue(group.label)];
}

function termSortValue(label: string): number {
	if (label.includes("後期") || label.includes("秋学期")) return 2;
	if (label.includes("前期") || label.includes("春学期")) return 1;
	return 0;
}
