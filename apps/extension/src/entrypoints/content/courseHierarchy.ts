import type { CourseDashboardEntry } from "@fuzzy/shared";

export interface CourseGroup {
	key: string;
	label: string;
	courses: CourseDashboardEntry[];
}

export function courseGroupLabel(course: CourseDashboardEntry): string {
	const term = normalizeCourseTerm(course.term);
	const year = course.academicYear;
	// 学年を含む「3年前期」などは、年度表記の有無にかかわらず同じグループにする。
	if (/^[1-9]年(?:前期|後期|春学期|秋学期)$/.test(term)) return term;
	if (term && year !== null && year !== undefined) {
		return `${year}年度 ${term}`;
	}
	if (term) return term;
	if (year !== null && year !== undefined) return `${year}年度`;
	return "学期未設定";
}

/** Moodleのコース名から確実に得られないクォーター表記は検索範囲に使わない。 */
export function normalizeCourseTerm(value: string | null | undefined): string {
	return (value ?? "")
		.normalize("NFKC")
		.replace(/(?:19|20|21)\d{2}\s*年度?/g, "")
		.replace(/(?:第\s*)?[1-4]\s*(?:Q|クォーター)/gi, "")
		.replace(/[・,，/／_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function groupCourses(courses: readonly CourseDashboardEntry[]): CourseGroup[] {
	const groups = new Map<string, CourseGroup>();
	for (const course of courses) {
		const label = courseGroupLabel(course);
		const key = label.normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase("ja-JP");
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
