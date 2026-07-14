import { describe, expect, test } from "bun:test";
import type { Assignment } from "@fuzzy/shared";
import {
	buildDeadlineIcs,
	deadlineIcsFileName,
	exportableAssignments,
} from "../../apps/extension/src/lib/calendar/ics";

const assignment: Assignment = {
	id: 10,
	courseId: 2,
	courseName: "データベース,演習",
	title: "課題;最終レポート",
	source: "moodle_dashboard",
	dueAt: "2026-07-20T12:30:00.000Z",
	dueAtStatus: "normal",
	submissionMode: "moodle_auto",
	submitted: false,
};

describe("締切ICS", () => {
	test("有効な締切をカレンダーイベントへ変換する", () => {
		const ics = buildDeadlineIcs([assignment], new Date("2026-07-14T00:00:00.000Z"));
		expect(ics).toContain("BEGIN:VCALENDAR\r\n");
		expect(ics).toContain("DTSTART:20260720T123000Z");
		expect(ics).toContain("SUMMARY:データベース\\,演習: 課題\\;最終レポート");
		expect(ics).toContain("UID:fuzzy-assignment-10@fuzzy.local");
		expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
	});

	test("期限未設定と不正な日付は書き出さない", () => {
		const noDate = { ...assignment, id: 11, dueAt: null };
		const invalidDate = { ...assignment, id: 12, dueAt: "invalid" };
		expect(exportableAssignments([assignment, noDate, invalidDate])).toEqual([assignment]);
	});

	test("ファイル名にローカル日付を含める", () => {
		expect(deadlineIcsFileName(new Date(2026, 6, 14))).toBe("fuzzy-deadlines-2026-07-14.ics");
	});

	test("長い日本語をUTF-8の途中で壊さず75オクテット以内に折り返す", () => {
		const longAssignment = {
			...assignment,
			title: "非常に長い日本語の課題名をカレンダーへ安全に書き出すための確認用レポート課題",
		};
		const ics = buildDeadlineIcs([longAssignment]);
		const encoder = new TextEncoder();
		const physicalLines = ics.split("\r\n").filter(Boolean);

		expect(physicalLines.every((line) => encoder.encode(line).length <= 75)).toBe(true);
		expect(physicalLines.some((line) => line.startsWith(" "))).toBe(true);
	});
});
