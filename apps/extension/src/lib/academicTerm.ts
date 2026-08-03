import type { CourseDashboardEntry } from "@fuzzy/shared";

export type AcademicTermName = "前期" | "後期";

export interface CurrentAcademicTerm {
	academicYear: number;
	term: AcademicTermName;
}

/** 和歌山大学の前期（4〜9月）／後期（10〜3月）を端末日付から求める。 */
export function currentAcademicTerm(now = new Date()): CurrentAcademicTerm {
	const year = now.getFullYear();
	const month = now.getMonth() + 1;
	if (month >= 4 && month <= 9) return { academicYear: year, term: "前期" };
	if (month >= 10) return { academicYear: year, term: "後期" };
	return { academicYear: year - 1, term: "後期" };
}

/** 年度・学期が明確に異なる場合だけtrueにし、判断できない資料は残す。 */
export function isDefinitelyOutsideCurrentTerm(
	course: CourseDashboardEntry | undefined,
	now = new Date(),
): boolean {
	if (!course) return false;
	const current = currentAcademicTerm(now);
	const termText = course.term?.replaceAll(/\s/g, "") ?? "";
	const termYear = termText.match(/(19\d{2}|20\d{2}|21\d{2})/);
	const academicYear =
		typeof course.academicYear === "number" && course.academicYear >= 1900
			? course.academicYear
			: termYear
				? Number(termYear[1])
				: null;
	if (academicYear !== null && academicYear !== current.academicYear) return true;

	const term =
		termText.includes("後期") || termText.includes("秋学期")
			? "後期"
			: termText.includes("前期") || termText.includes("春学期")
				? "前期"
				: null;
	return academicYear === current.academicYear && term !== null && term !== current.term;
}
