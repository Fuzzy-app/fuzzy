import { describe, expect, test } from "bun:test";
import {
	currentAcademicTerm,
	isDefinitelyOutsideCurrentTerm,
} from "../../apps/extension/src/lib/academicTerm";

describe("現在の大学学期判定", () => {
	test("4月から9月を前期、10月から3月を後期として扱う", () => {
		expect(currentAcademicTerm(new Date(2026, 7, 3))).toEqual({
			academicYear: 2026,
			term: "前期",
		});
		expect(currentAcademicTerm(new Date(2027, 1, 3))).toEqual({
			academicYear: 2026,
			term: "後期",
		});
	});

	test("年度が明確に違う資料だけを除外し、情報不足は残す", () => {
		const now = new Date(2026, 7, 3);
		expect(
			isDefinitelyOutsideCurrentTerm(
				{
					courseId: 1,
					courseName: "旧授業",
					academicYear: 2025,
					term: "前期",
					fileCount: 1,
					violationCount: 0,
					nextDueAt: null,
				},
				now,
			),
		).toBe(true);
		expect(
			isDefinitelyOutsideCurrentTerm(
				{
					courseId: 2,
					courseName: "学年表記だけ",
					academicYear: null,
					term: "1年前期",
					fileCount: 1,
					violationCount: 0,
					nextDueAt: null,
				},
				now,
			),
		).toBe(false);
	});
});
