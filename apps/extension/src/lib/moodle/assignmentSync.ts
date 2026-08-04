import type { ReconcileCourseFilesRequest, SyncMoodleAssignmentsRequest } from "@fuzzy/shared";
import {
	FUZZY_QA_MOODLE_HTTPS_MATCH_PATTERN,
	isSupportedMoodleAssignmentUrl,
} from "../../../moodleSite";
import { type MoodlePageSnapshot, hasCompleteAssignmentHintExtraction } from "./pageSnapshot";

const FUZZY_QA_MOODLE_ORIGIN = FUZZY_QA_MOODLE_HTTPS_MATCH_PATTERN.slice(0, -2);
const FUZZY_QA_ACADEMIC_YEAR = 2026;

/** Moodleのホスト・年度・コースIDを組み合わせ、年度をまたいだ同一IDの衝突を防ぐ。 */
export function contextualMoodleCourseId(
	snapshot: MoodlePageSnapshot,
	pageUrl: string,
): string | null {
	const rawId = snapshot.moodleCourseId?.trim() ?? "";
	if (!/^[A-Za-z0-9._:-]{1,80}$/.test(rawId)) return null;
	if (!pageUrl) return rawId;
	try {
		const hostname = new URL(pageUrl).hostname.toLowerCase();
		if (!hostname) return null;
		const year = resolveMoodleAcademicYear(snapshot, pageUrl);
		if (year === null) return null;
		const contextualId = `moodle:${hostname}:${year}:${rawId}`;
		return contextualId.length <= 128 ? contextualId : null;
	} catch {
		return null;
	}
}

/**
 * course/view.phpだけを当該コースの完全snapshotとして送る。
 * 個別活動ページの部分DOMを完全snapshotとして送って、未表示課題をremoved扱いにしない。
 */
export function buildMoodleAssignmentSyncPayload(
	snapshot: MoodlePageSnapshot,
	pageUrl: string,
	root: Document | Element = document,
): SyncMoodleAssignmentsRequest | null {
	if (!isCompleteCoursePage(pageUrl, root)) return null;
	if (!hasCompleteAssignmentHintExtraction(root, snapshot.assignmentHints)) return null;
	const academicYear = resolveMoodleAcademicYear(snapshot, pageUrl);
	const moodleCourseId = contextualMoodleCourseId(snapshot, pageUrl) ?? "";
	const courseName = snapshot.courseName?.trim() ?? "";
	if (
		!/^[A-Za-z0-9._:-]{1,128}$/.test(moodleCourseId) ||
		courseName.length === 0 ||
		courseName.length > 512
	) {
		return null;
	}

	const seen = new Set<string>();
	const assignments: SyncMoodleAssignmentsRequest["assignments"] = [];
	for (const hint of snapshot.assignmentHints) {
		const moodleAssignmentId = hint.moodleAssignmentId;
		if (!moodleAssignmentId) continue;
		if (!/^[A-Za-z0-9._:-]{1,128}$/.test(moodleAssignmentId)) return null;
		if (seen.has(moodleAssignmentId)) continue;

		const title = hint.title.trim();
		// ID付きリンクを不正値として黙って落とすと既存課題がremoved扱いになるため、
		// snapshot全体を送らず次の正常なコース表示を待つ。
		if (!title || title.length > 512) return null;

		seen.add(moodleAssignmentId);
		const parsedDue = parseMoodleDueAt(hint.dueText, academicYear, snapshot.collectedAt);
		assignments.push({
			moodleAssignmentId,
			title,
			dueAt: parsedDue.dueAt,
			source: hint.source === "dashboard_widget" ? "moodle_dashboard" : "moodle_text",
			dueAtStatus: parsedDue.dueAtStatus,
			submissionMode: "moodle_auto",
			submitted: hint.submitted,
			submissionAvailability: hint.submissionAvailability,
			moodleUrl:
				hint.moodleUrl === null || isSupportedMoodleAssignmentUrl(hint.moodleUrl)
					? hint.moodleUrl
					: null,
		});
	}

	return {
		trigger: "auto",
		course: {
			moodleCourseId,
			name: courseName,
			academicYear,
			term: snapshot.term,
		},
		assignments,
	};
}

/** 完全なコースページの表示時だけ、当該コースに限定した差分走査要求を作る。 */
export function buildCourseFileReconcilePayload(
	snapshot: MoodlePageSnapshot,
	pageUrl: string,
	root: Document | Element = document,
): ReconcileCourseFilesRequest | null {
	if (!isCompleteCoursePage(pageUrl, root)) return null;
	const academicYear = resolveMoodleAcademicYear(snapshot, pageUrl);
	const moodleCourseId = contextualMoodleCourseId(snapshot, pageUrl) ?? "";
	const name = snapshot.courseName?.trim() ?? "";
	if (!/^[A-Za-z0-9._:-]{1,128}$/.test(moodleCourseId) || !name || name.length > 1_000) {
		return null;
	}
	return {
		course: {
			moodleCourseId,
			name,
			academicYear,
			term: snapshot.term,
		},
	};
}

/** 審査専用QAサイトでは、DOMに年度がなくてもサイト名で固定された年度を補う。 */
function resolveMoodleAcademicYear(snapshot: MoodlePageSnapshot, pageUrl: string): number | null {
	if (snapshot.academicYear !== null) return snapshot.academicYear;
	try {
		const url = new URL(pageUrl);
		return url.origin === FUZZY_QA_MOODLE_ORIGIN && url.username === "" && url.password === ""
			? FUZZY_QA_ACADEMIC_YEAR
			: null;
	} catch {
		return null;
	}
}

export function parseMoodleDueAt(
	dueText: string | null,
	academicYear: number | null,
	collectedAt: string,
): { dueAt: string | null; dueAtStatus: "normal" | "needs_review" } {
	if (!dueText?.trim()) return { dueAt: null, dueAtStatus: "normal" };
	const normalized = dueText.normalize("NFKC").replace(/\s+/g, " ").trim();

	const explicitIso = normalized.match(
		/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})\b/,
	)?.[0];
	if (explicitIso) {
		const timestamp = Date.parse(explicitIso);
		if (Number.isFinite(timestamp)) {
			return { dueAt: new Date(timestamp).toISOString(), dueAtStatus: "normal" };
		}
	}

	const englishDate = parseEnglishMoodleDueAt(normalized);
	if (englishDate) return { dueAt: englishDate, dueAtStatus: "normal" };

	const match = normalized.match(
		/(?:(\d{4})\s*[年/-]\s*)?(\d{1,2})\s*[月/-]\s*(\d{1,2})\s*日?(?:\s*(?:\([^)]+\)|（[^）]+）))?(?:\s*(\d{1,2})[:：](\d{2}))?/,
	);
	if (!match) return { dueAt: null, dueAtStatus: "needs_review" };

	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = match[4] === undefined ? 23 : Number(match[4]);
	const minute = match[5] === undefined ? 59 : Number(match[5]);
	const explicitYear = match[1] ? Number(match[1]) : null;
	const year =
		explicitYear ??
		inferDueYear(
			academicYear,
			month,
			Number.isFinite(Date.parse(collectedAt)) ? new Date(collectedAt) : new Date(),
		);
	if (!isValidJstDate(year, month, day, hour, minute)) {
		return { dueAt: null, dueAtStatus: "needs_review" };
	}

	return {
		dueAt: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(
			day,
		).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(
			2,
			"0",
		)}:00+09:00`,
		dueAtStatus: explicitYear !== null && match[4] !== undefined ? "normal" : "needs_review",
	};
}

const ENGLISH_MONTHS: Readonly<Record<string, number>> = {
	jan: 1,
	feb: 2,
	mar: 3,
	apr: 4,
	may: 5,
	jun: 6,
	jul: 7,
	aug: 8,
	sep: 9,
	oct: 10,
	nov: 11,
	dec: 12,
};

/** Moodle英語表示の長い日時（例: Tuesday, 11 August 2026, 11:59 PM）をJSTで読む。 */
function parseEnglishMoodleDueAt(value: string): string | null {
	const monthName =
		"January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";
	const dayFirst = value.match(
		new RegExp(
			`\\b(\\d{1,2})\\s+(${monthName})\\s+(\\d{4})(?:,\\s*|\\s+)(\\d{1,2}):(\\d{2})(?:\\s*(AM|PM))?\\b`,
			"i",
		),
	);
	const monthFirst = value.match(
		new RegExp(
			`\\b(${monthName})\\s+(\\d{1,2}),?\\s+(\\d{4})(?:,\\s*|\\s+)(\\d{1,2}):(\\d{2})(?:\\s*(AM|PM))?\\b`,
			"i",
		),
	);
	const match = dayFirst ?? monthFirst;
	if (!match) return null;

	const day = Number(dayFirst ? match[1] : match[2]);
	const monthToken = (dayFirst ? match[2] : match[1]) ?? "";
	const month = ENGLISH_MONTHS[monthToken.slice(0, 3).toLowerCase()] ?? 0;
	const year = Number(match[3]);
	let hour = Number(match[4]);
	const minute = Number(match[5]);
	const meridiem = match[6]?.toUpperCase() ?? null;
	if (meridiem) {
		if (hour < 1 || hour > 12) return null;
		hour = (hour % 12) + (meridiem === "PM" ? 12 : 0);
	}
	if (!isValidJstDate(year, month, day, hour, minute)) return null;

	return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(
		2,
		"0",
	)}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+09:00`;
}

export function isCompleteCoursePage(pageUrl: string, root: Document | Element): boolean {
	try {
		const url = new URL(pageUrl);
		if (!/\/course\/view\.php$/i.test(url.pathname) || !url.searchParams.get("id")) return false;
		const partialViewParameters =
			/^(?:section|sectionid|sectionnumber|showsection|singlesection|topic|week)$/i;
		if ([...url.searchParams.keys()].some((key) => partialViewParameters.test(key))) {
			return false;
		}
		const courseContent = root.querySelector<HTMLElement>(
			".course-content, [data-region='course-content'], [data-course-content]",
		);
		if (!courseContent) return false;

		// Moodleの描画途中や「続きを読み込む」状態を完全snapshotとして扱うと、
		// 未描画の課題をremovedにしてしまうため同期を次回表示まで見送る。
		const incompleteSelector = [
			"[aria-busy='true']",
			"[data-region='loading-placeholder']",
			"[data-region='course-content-loading']",
			"[data-action='loadmore']",
			"[data-action='load-more']",
			".skeleton",
			".placeholder-glow",
		].join(", ");
		const incompleteMarker = courseContent.matches(incompleteSelector)
			? courseContent
			: courseContent.querySelector<HTMLElement>(incompleteSelector);
		if (incompleteMarker && !isHidden(incompleteMarker)) return false;

		// 空のコースにも概要セクションは存在する。セクションが1件もないDOMは、
		// 初期HTMLだけを見ている可能性があるため完全一覧とはみなさない。
		return Boolean(
			courseContent.matches("li.section, .course-section, [data-sectionid]") ||
				courseContent.querySelector("li.section, .course-section, [data-sectionid]"),
		);
	} catch {
		return false;
	}
}

function isHidden(element: HTMLElement): boolean {
	const inlineStyle = element.getAttribute("style")?.replace(/\s+/g, "").toLowerCase() ?? "";
	return (
		element.hidden ||
		element.getAttribute("aria-hidden") === "true" ||
		element.classList.contains("d-none") ||
		element.classList.contains("hidden") ||
		inlineStyle.includes("display:none") ||
		inlineStyle.includes("visibility:hidden")
	);
}

function inferDueYear(academicYear: number | null, month: number, collectedAt: Date): number {
	if (academicYear !== null && academicYear >= 1900 && academicYear <= 9999) {
		return month <= 3 ? academicYear + 1 : academicYear;
	}
	// Date#getUTC*では閲覧環境のタイムゾーンに依存するため、JSTへずらして年度を得る。
	const collectedInJst = new Date(collectedAt.getTime() + 9 * 60 * 60 * 1000);
	return collectedInJst.getUTCFullYear();
}

function isValidJstDate(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
): boolean {
	if (
		!Number.isInteger(year) ||
		year < 1900 ||
		year > 9999 ||
		!Number.isInteger(month) ||
		month < 1 ||
		month > 12 ||
		!Number.isInteger(day) ||
		day < 1 ||
		!Number.isInteger(hour) ||
		hour < 0 ||
		hour > 23 ||
		!Number.isInteger(minute) ||
		minute < 0 ||
		minute > 59
	) {
		return false;
	}
	return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}
