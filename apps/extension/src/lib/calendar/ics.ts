import type { Assignment } from "@fuzzy/shared";

const CRLF = "\r\n";

function formatUtcDate(date: Date): string {
	return date
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
}

function escapeIcsText(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/\r?\n/g, "\\n")
		.replace(/,/g, "\\,")
		.replace(/;/g, "\\;");
}

/** RFC 5545推奨の75オクテット以内で、UTF-8文字を分断せずに行を折り返す。 */
function foldIcsLine(line: string): string {
	const encoder = new TextEncoder();
	const segments: string[] = [];
	let segment = "";
	let segmentBytes = 0;
	let contentLimit = 75;

	for (const character of line) {
		const characterBytes = encoder.encode(character).length;
		if (segment && segmentBytes + characterBytes > contentLimit) {
			segments.push(segment);
			segment = character;
			segmentBytes = characterBytes;
			// 継続行の先頭には半角スペースが1オクテット付くため、本文は74までにする。
			contentLimit = 74;
			continue;
		}
		segment += character;
		segmentBytes += characterBytes;
	}

	segments.push(segment);
	return segments.join(`${CRLF} `);
}

function validDueDate(assignment: Assignment): Date | null {
	if (!assignment.dueAt) return null;
	const time = Date.parse(assignment.dueAt);
	return Number.isNaN(time) ? null : new Date(time);
}

export function exportableAssignments(assignments: Assignment[]): Assignment[] {
	return assignments.filter((assignment) => validDueDate(assignment) !== null);
}

/**
 * Moodleから取得した締切を、Googleカレンダー等へ読み込めるICS形式へ変換する。
 * 日付未設定・不正な日付は誤った予定を作らないよう書き出し対象から除外する。
 */
export function buildDeadlineIcs(assignments: Assignment[], generatedAt = new Date()): string {
	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Fuzzy//Deadline Calendar//JA",
		"CALSCALE:GREGORIAN",
		"METHOD:PUBLISH",
		"X-WR-CALNAME:Fuzzy 締切",
	];

	for (const assignment of exportableAssignments(assignments)) {
		const dueDate = validDueDate(assignment);
		if (!dueDate) continue;
		lines.push(
			"BEGIN:VEVENT",
			`UID:fuzzy-assignment-${assignment.id}@fuzzy.local`,
			`DTSTAMP:${formatUtcDate(generatedAt)}`,
			`DTSTART:${formatUtcDate(dueDate)}`,
			`SUMMARY:${escapeIcsText(`${assignment.courseName}: ${assignment.title}`)}`,
			`DESCRIPTION:${escapeIcsText(`Fuzzyから書き出した締切です。提出方法: ${assignment.submissionMode}`)}`,
			`X-FUZZY-ASSIGNMENT-ID:${assignment.id}`,
			"END:VEVENT",
		);
	}

	lines.push("END:VCALENDAR");
	return `${lines.map(foldIcsLine).join(CRLF)}${CRLF}`;
}

export function deadlineIcsFileName(now = new Date()): string {
	const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
		.map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
		.join("-");
	return `fuzzy-deadlines-${date}.ics`;
}
