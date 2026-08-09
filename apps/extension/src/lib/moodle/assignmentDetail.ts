import type { Assignment } from "@fuzzy/shared";
import { boundedParallelMap } from "../boundedParallelMap";
import { isHtmlResponse, readLimitedResponseText } from "./limitedResponse";
import { classifyMoodlePage } from "./pageClassification";
import type { MoodleAssignmentHint } from "./pageSnapshot";

type SubmissionAvailability = Assignment["submissionAvailability"];

export interface AssignmentSubmissionState {
	availability: SubmissionAvailability;
	/** nullは詳細HTMLから提出状態を確定できなかったことを表す。 */
	submitted: boolean | null;
}

export const ASSIGNMENT_DETAIL_LIMITS = {
	maxAssignments: 50,
	concurrency: 4,
	timeoutMs: 10_000,
	maxHtmlBytes: 2 * 1024 * 1024,
} as const;

export interface AssignmentDetailProgress {
	completed: number;
	total: number;
	unknown: number;
	skipped: number;
}

interface AssignmentDetailFetchOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
	parseHtml?: (html: string) => Document;
	onProgress?: (progress: AssignmentDetailProgress) => void;
}

const ASSIGNMENT_DETAIL_PATH = /^\/mod\/assign\/view\.php$/i;
const SUBMISSION_ACTION_TEXT =
	/(?:提出を(?:アップロード・入力|追加|編集|開始|更新)する|提出物を(?:追加|編集|アップロード)する|課題を提出する|add submission|edit submission|upload submission|submit assignment)/i;
const UNAVAILABLE_TEXT =
	/(?:提出受付(?:は|が)?終了|提出を受け付けていません|提出する権限がありません|提出はロックされています|再提出できません|この課題を提出できません|submissions? (?:are|is) closed|not (?:permitted|allowed) to submit|cannot submit|submission is locked)/i;
const UNEXPECTED_PAGE_TEXT =
	/(?:メンテナンス中|一時的に利用できません|予期しないエラー|サイト管理者に連絡|maintenance mode|temporarily unavailable|internal server error)/i;
const SUBMISSION_FORM_PATH = /^\/mod\/assign\/(?:view|submission)\.php$/i;

/**
 * コース一覧から得た課題候補を、認証済みの同一オリジン詳細ページで補完する。
 * 1件の失敗はunknownへ閉じ込め、他の候補の確認を継続する。
 */
export async function collectAssignmentSubmissionAvailability(
	hints: readonly MoodleAssignmentHint[],
	options: AssignmentDetailFetchOptions = {},
): Promise<MoodleAssignmentHint[]> {
	const baseUrl = options.baseUrl ?? currentPageUrl();
	const fetchImpl = options.fetch ?? fetch;
	const parseHtml =
		options.parseHtml ?? ((html: string) => new DOMParser().parseFromString(html, "text/html"));
	const uniqueUrls = Array.from(
		new Set(
			hints.flatMap((hint) => {
				const normalized = normalizeMoodleAssignmentDetailUrl(hint.moodleUrl, baseUrl);
				return normalized ? [normalized] : [];
			}),
		),
	);
	const urls = uniqueUrls.slice(0, ASSIGNMENT_DETAIL_LIMITS.maxAssignments);
	const skipped = uniqueUrls.length - urls.length;
	const stateByUrl = new Map<string, AssignmentSubmissionState>();
	let completed = 0;
	let unknown = 0;

	const reportProgress = () => {
		options.onProgress?.({ completed, total: urls.length, unknown, skipped });
	};
	reportProgress();

	await boundedParallelMap(urls, ASSIGNMENT_DETAIL_LIMITS.concurrency, async (url) => {
		let state: AssignmentSubmissionState = { availability: "unknown", submitted: null };
		try {
			const document = await fetchAssignmentDetailDocument(url, baseUrl, fetchImpl, parseHtml);
			state = document ? analyzeAssignmentSubmissionState(document, url) : state;
		} catch {
			state = { availability: "unknown", submitted: null };
		}
		stateByUrl.set(url, state);
		completed += 1;
		if (state.availability === "unknown") unknown += 1;
		reportProgress();
		return state;
	});

	return hints.map((hint) => {
		const detailUrl = normalizeMoodleAssignmentDetailUrl(hint.moodleUrl, baseUrl);
		const detailState = detailUrl ? stateByUrl.get(detailUrl) : undefined;
		return {
			...hint,
			// assign以外（quiz等）の利用者向けURLは失わず、詳細取得の対象だけを正規化する。
			moodleUrl: detailUrl ?? hint.moodleUrl,
			submissionAvailability: detailUrl
				? (detailState?.availability ?? "unknown")
				: hint.submissionAvailability,
			submitted: detailState?.submitted ?? hint.submitted,
		};
	});
}

/**
 * Moodle課題詳細URLを、fragmentを除いた同一オリジンのHTTPS URLへ正規化する。
 * 現時点でDOM判定を保証できるassignモジュールだけを許可する。
 */
export function normalizeMoodleAssignmentDetailUrl(
	value: string | null,
	baseUrl: string,
): string | null {
	if (!value) return null;
	try {
		const base = new URL(baseUrl);
		const candidate = new URL(value, base);
		const assignmentId = candidate.searchParams.get("id");
		if (
			base.protocol !== "https:" ||
			candidate.protocol !== "https:" ||
			candidate.origin !== base.origin ||
			!ASSIGNMENT_DETAIL_PATH.test(candidate.pathname) ||
			!assignmentId ||
			!/^\d+$/.test(assignmentId)
		) {
			return null;
		}
		const normalized = new URL("/mod/assign/view.php", candidate.origin);
		normalized.searchParams.set("id", assignmentId);
		return normalized.href;
	} catch {
		return null;
	}
}

/**
 * 課題詳細HTMLの根拠を競合込みで評価する。
 * 動的IDは参照せず、操作文言・disabled・フォーム遷移先・ページ状態を組み合わせる。
 */
export function analyzeAssignmentSubmissionAvailability(
	document: Document,
	pageUrl: string,
): SubmissionAvailability {
	return analyzeAssignmentSubmissionState(document, pageUrl).availability;
}

export function analyzeAssignmentSubmissionState(
	document: Document,
	pageUrl: string,
): AssignmentSubmissionState {
	if (classifyMoodlePage(document, pageUrl) !== "authenticated") {
		return { availability: "unknown", submitted: null };
	}

	const pageText = normalizeText(
		(document.querySelector("main, #region-main, [role='main']") ?? document.body)?.textContent,
	);
	if (!pageText || UNEXPECTED_PAGE_TEXT.test(pageText)) {
		return { availability: "unknown", submitted: null };
	}
	const submitted = analyzeStructuredSubmittedStatus(document);

	const unavailableEvidence = UNAVAILABLE_TEXT.test(pageText);
	let availableEvidence = false;
	let disabledEvidence = false;

	for (const element of document.querySelectorAll<HTMLElement>(
		"button[type='submit'], input[type='submit'], a[href], [role='button']",
	)) {
		const isInput = element.tagName.toLowerCase() === "input";
		const label = normalizeText(
			isInput
				? element.getAttribute("value") || element.getAttribute("aria-label")
				: element.textContent ||
						element.getAttribute("aria-label") ||
						element.getAttribute("title"),
		);
		if (!SUBMISSION_ACTION_TEXT.test(label)) continue;

		const disabled = isDisabled(element);
		if (disabled) {
			disabledEvidence = true;
			continue;
		}
		if (hasAllowedSubmissionTarget(element, pageUrl)) availableEvidence = true;
	}

	const availability =
		availableEvidence && (unavailableEvidence || disabledEvidence)
			? "unknown"
			: availableEvidence
				? "available"
				: unavailableEvidence || disabledEvidence
					? "unavailable"
					: "unknown";
	return { availability, submitted };
}

function analyzeStructuredSubmittedStatus(document: Document): boolean | null {
	for (const row of document.querySelectorAll<HTMLTableRowElement>(
		".submissionstatustable tr, .submissionsummarytable tr",
	)) {
		const heading = normalizeText(row.querySelector("th")?.textContent);
		if (!/^(?:提出ステータス|submission status)$/i.test(heading)) continue;
		const cell = row.querySelector<HTMLElement>("td");
		const status = normalizeText(cell?.textContent);
		if (
			cell?.classList.contains("submissionstatussubmitted") ||
			/(?:評定のために提出済み|submitted for grading|submission submitted)/i.test(status)
		) {
			return true;
		}
		if (/(?:未提出|提出なし|下書き|no submission|not submitted|draft)/i.test(status)) return false;
	}
	return null;
}

async function fetchAssignmentDetailDocument(
	url: string,
	baseUrl: string,
	fetchImpl: typeof fetch,
	parseHtml: (html: string) => Document,
): Promise<Document | null> {
	if (!normalizeMoodleAssignmentDetailUrl(url, baseUrl)) return null;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), ASSIGNMENT_DETAIL_LIMITS.timeoutMs);
	try {
		const response = await fetchImpl(url, {
			credentials: "include",
			signal: controller.signal,
			headers: { Accept: "text/html,application/xhtml+xml" },
		});
		if (!response.ok) return null;
		const responseUrl = normalizeMoodleAssignmentDetailUrl(response.url || url, baseUrl);
		// 同一Moodle内でも別課題への遷移結果を元の課題へ誤って紐付けない。
		if (!responseUrl || responseUrl !== url) return null;
		if (!isHtmlResponse(response)) return null;

		const html = await readLimitedResponseText(response, ASSIGNMENT_DETAIL_LIMITS.maxHtmlBytes);
		if (html === null) return null;
		const parsed = parseHtml(html);
		const base = parsed.createElement("base");
		base.href = responseUrl;
		parsed.head.prepend(base);
		return parsed;
	} finally {
		clearTimeout(timeout);
	}
}

function hasAllowedSubmissionTarget(element: HTMLElement, pageUrl: string): boolean {
	const tagName = element.tagName.toLowerCase();
	const associatedForm =
		tagName === "button" || tagName === "input"
			? ((element as HTMLButtonElement | HTMLInputElement).form ??
				element.closest<HTMLFormElement>("form"))
			: element.closest<HTMLFormElement>("form");
	const linkTarget = tagName === "a" ? element.getAttribute("href") : null;
	if (!associatedForm && !linkTarget) return false;
	const rawTarget = associatedForm?.getAttribute("action") ?? linkTarget;
	try {
		const page = new URL(pageUrl);
		const target = new URL(rawTarget || pageUrl, page);
		if (
			target.protocol !== "https:" ||
			target.origin !== page.origin ||
			!SUBMISSION_FORM_PATH.test(target.pathname)
		) {
			return false;
		}
		if (associatedForm) {
			const method = (associatedForm.getAttribute("method") ?? "get").toLowerCase();
			if (method !== "get" && method !== "post") return false;
		}
		return true;
	} catch {
		return false;
	}
}

function isDisabled(element: HTMLElement): boolean {
	if (
		element.hasAttribute("disabled") ||
		element.getAttribute("aria-disabled") === "true" ||
		element.classList.contains("disabled")
	) {
		return true;
	}
	const fieldset = element.closest<HTMLFieldSetElement>("fieldset[disabled]");
	return fieldset !== null;
}

function normalizeText(value: string | null | undefined): string {
	return value?.normalize("NFKC").replace(/\s+/g, " ").trim() ?? "";
}

function currentPageUrl(): string {
	return typeof location === "undefined" ? "" : location.href;
}
