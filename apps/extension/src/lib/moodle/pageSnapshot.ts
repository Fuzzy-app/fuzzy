import type { Assignment, MoodleFileMeta } from "@fuzzy/shared";
import {
	fileExtensionFromName,
	fileTypeFromMoodleIconUrl,
	hasSupportedFileExtension,
	normalizeFileTypeHint,
} from "./fileType";

/**
 * ページから抽出したファイルリンク。保存API（saveFiles等）へそのまま渡すため、
 * 共有API型 MoodleFileMeta と定義を共有し、二重定義を避ける。
 */
export type MoodleFileLink = MoodleFileMeta;

export interface MoodleFolderLink {
	title: string;
	url: string;
	sectionTitle: string | null;
}

export interface MoodleAssignmentHint {
	/** course-module URL等から得たコース内で安定したID。推測できない文面候補はnull。 */
	moodleAssignmentId: string | null;
	title: string;
	dueText: string | null;
	sourceText: string;
	source: "page_text" | "dashboard_widget";
	submitted: boolean;
	/** 締切・提出済み状態・submissionModeとは独立した、詳細ページ上の提出可否。 */
	submissionAvailability: Assignment["submissionAvailability"];
	/** 利用者操作と詳細ページ取得に使う、正規化済みのMoodle課題URL。 */
	moodleUrl: string | null;
}

const SUBMISSION_UNAVAILABLE_PATTERN =
	/(?:提出(?:を受け付けていません|できません|期間は終了)|受付(?:終了|停止)|利用できません|closed|no longer available|not available)/i;
const SUBMISSION_AVAILABLE_PATTERN =
	/(?:提出(?:を追加|物をアップロード|する)|小テストを受験|回答を開始|add submission|upload submission|attempt quiz now|start attempt)/i;

export interface MoodlePageSnapshot {
	moodleCourseId: string | null;
	courseName: string | null;
	academicYear: number | null;
	term: string | null;
	sectionTitle: string | null;
	breadcrumbs: string[];
	files: MoodleFileLink[];
	pageText: string;
	dashboardText: string;
	assignmentHints: MoodleAssignmentHint[];
	collectedAt: string;
}

export const MOODLE_PAGE_SNAPSHOT_MESSAGE = "fuzzy:getMoodlePageSnapshot";

const MOODLE_DIRECT_FILE_PATTERN = /\/pluginfile\.php\//i;
const MOODLE_RESOURCE_PATTERN = /\/mod\/resource\/view\.php/i;
const MOODLE_FOLDER_PATTERN = /\/mod\/folder\/view\.php/i;
const MOODLE_ASSIGNMENT_PATTERN = /\/mod\/(assign|quiz)\/view\.php/i;
const MOODLE_ACTIVITY_SELECTOR = "li.activity, .activity, [data-activityname]";
const MOODLE_SECTION_CONTAINER_SELECTOR = [
	"[data-section-name]",
	"[data-sectionid]",
	"[data-section-number]",
	"[data-region='section']",
	"[id^='section-']",
	"li.section",
	".course-section",
].join(", ");
const MOODLE_SECTION_HEADING_SELECTOR = [
	".sectionname",
	".section-title",
	"[data-region='section-title']",
	".course-section-header h2",
	".course-section-header h3",
	".course-section-header h4",
	"[data-region='section'] > header h2",
	"[data-region='section'] > header h3",
	"[data-region='section'] > header h4",
	"[id^='section-'] > header h2",
	"[id^='section-'] > header h3",
	"[id^='section-'] > header h4",
].join(", ");
const WEB_PAGE_MIME_HINTS = new Set(["htm", "html"]);
const ASSIGNMENT_KEYWORD_PATTERN =
	/(課題|レポート|提出|締切|期限|小テスト|quiz|assignment|report|due)/i;
const DUE_TEXT_PATTERN =
	/(?:提出期限|締切|期限|due\s*date|due)[:：\s]*(\d{4}[/-]\d{1,2}[/-]\d{1,2}(?:\s+\d{1,2}:\d{2})?|[0-9０-９]{1,2}月[0-9０-９]{1,2}日(?:\s*[0-9０-９]{1,2}[:：][0-9０-９]{2})?|[^。．\n]{1,40})/i;
const ACADEMIC_TERM_PATTERN =
	/(?:(?:19|20)\d{2}\s*(?:年度)?\s*(?:前期|後期|通年|春学期|秋学期|第[12一二]学期)|[1-9]年\s*(?:前期|後期|春学期|秋学期)|(?:前期|後期|通年|春学期|秋学期|第[12一二]学期)(?:\s*(?:19|20)\d{2})?|(?:19|20)\d{2}\s*(?:spring|fall|autumn)(?:\s+(?:semester|term))?|(?:spring|fall|autumn)(?:\s+(?:semester|term))?\s*(?:19|20)\d{2}|(?:first|second|1st|2nd)\s+semester)/i;
const NON_COURSE_LINK_CONTAINER_SELECTOR = [
	"nav",
	"header",
	"footer",
	".breadcrumb",
	".portal-newsitem",
	".portal-news",
	".block_news_items",
	".block_myoverview",
	".block_timeline",
	".block_calendar_upcoming",
	"[data-region='drawer']",
	"#nav-drawer",
].join(", ");

export function collectMoodlePageSnapshot(root: Document | Element = document): MoodlePageSnapshot {
	const pageText = extractPageText(root);
	const dashboardText = extractDashboardText(root);

	return {
		moodleCourseId: extractMoodleCourseId(root),
		courseName: extractCourseName(root),
		academicYear: extractAcademicYear(root),
		term: extractAcademicTerm(root),
		sectionTitle: extractSectionTitle(root),
		breadcrumbs: extractBreadcrumbs(root),
		files: extractFileLinks(root),
		pageText,
		dashboardText,
		assignmentHints: [
			...extractStructuredAssignmentHints(root),
			...extractAssignmentHints(pageText, "page_text"),
			...extractAssignmentHints(dashboardText, "dashboard_widget"),
		],
		collectedAt: new Date().toISOString(),
	};
}

/** MoodleのDOM・course/view.php URLから、年度をまたいでも安定したコースIDを取得する。 */
export function extractMoodleCourseId(root: Document | Element = document): string | null {
	for (const element of [
		isDocumentRoot(root) ? root.documentElement : root,
		isDocumentRoot(root) ? root.body : root.ownerDocument.body,
		root.querySelector("[data-courseid], [data-course-id]"),
	]) {
		const value =
			element?.getAttribute("data-courseid") ?? element?.getAttribute("data-course-id") ?? null;
		if (value && /^[A-Za-z0-9._:-]{1,128}$/.test(value)) return value;
	}

	const baseUrl = safeUrl(getBaseUri(root));
	if (baseUrl && /\/course\/view\.php$/i.test(baseUrl.pathname)) {
		const value = baseUrl.searchParams.get("id");
		if (value && /^[A-Za-z0-9._:-]{1,128}$/.test(value)) return value;
	}
	return null;
}

/** 年度はMoodle文脈から独立して読み取り、term文字列の派生値として扱わない。 */
export function extractAcademicYear(root: Document | Element = document): number | null {
	const structured = root.querySelector("[data-academic-year]")?.getAttribute("data-academic-year");
	const candidates = [
		structured,
		...extractBreadcrumbs(root),
		textOf(root.querySelector(".page-header-headings h1")),
		textOf(root.querySelector("h1")),
		extractCourseName(root),
	];
	for (const candidate of candidates) {
		const year = Number.parseInt(
			candidate?.match(/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/)?.[1] ?? "",
			10,
		);
		if (year >= 1900 && year <= 9999) return year;
	}
	return null;
}

/** Moodleが表示する学期ラベルを加工せず、年度とは別フィールドで返す。 */
export function extractAcademicTerm(root: Document | Element = document): string | null {
	const structured = normalizeText(
		root.querySelector("[data-academic-term]")?.getAttribute("data-academic-term"),
	);
	if (structured) return structured;
	for (const candidate of [...extractBreadcrumbs(root), extractCourseName(root) ?? ""]) {
		const term = normalizeText(candidate).match(ACADEMIC_TERM_PATTERN)?.[0]?.trim();
		if (term) return term;
	}
	return null;
}

export function extractCourseName(root: Document | Element = document): string | null {
	const candidates = [
		textOf(root.querySelector(".page-header-headings h1")),
		textOf(root.querySelector("h1")),
		...extractBreadcrumbs(root).slice(-2),
	];

	return firstMeaningful(candidates.filter((candidate) => !isMoodleSiteTitle(candidate)));
}

/** Moodleのサイト名はコース名として保存しない。年度情報は別フィールドで扱う。 */
export function isMoodleSiteTitle(value: string | null | undefined): boolean {
	const normalized = normalizeText(value);
	if (!normalized) return false;
	return /(?:(?:\[[^\]]*\]|\u3010[^\u3011]*\u3011)\s*)?Moodle\s*20\d{2}$/i.test(normalized);
}

export function extractSectionTitle(root: Document | Element = document): string | null {
	const currentSection = root.querySelector(
		"li.section.current, .course-section.current, [data-region='section'][aria-current='true']",
	);
	if (currentSection) {
		const currentTitle = sectionContainerTitle(currentSection);
		if (currentTitle) return currentTitle;
	}

	const heading = Array.from(root.querySelectorAll(MOODLE_SECTION_HEADING_SELECTOR)).find(
		(candidate) => !candidate.closest(MOODLE_ACTIVITY_SELECTOR),
	);
	return textOf(heading ?? null);
}

export function extractBreadcrumbs(root: Document | Element = document): string[] {
	const items = root.querySelectorAll(
		".breadcrumb-item, nav[aria-label='breadcrumb'] li, .breadcrumb li",
	);

	return uniqueNonEmpty(Array.from(items).map((item) => textOf(item)));
}

export function extractFileLinks(root: Document | Element = document): MoodleFileLink[] {
	const contentRoot = findMoodleContentRoot(root);
	const links = Array.from(contentRoot.querySelectorAll<HTMLAnchorElement>("a[href]"));
	const precedingSectionTitles = createPrecedingSectionTitleLookup(contentRoot, links);
	const files = links.filter(isFileLikeLink).map((link) => {
		const url = normalizeUrl(link.href, root);
		const mimeHint = extractMimeHint(link, url);
		return {
			title: extractFileTitle(link, url, mimeHint),
			url,
			moodleFileId: extractMoodleFileId(url),
			sectionTitle: findSectionTitle(link, precedingSectionTitles.get(link) ?? null),
			mimeHint,
		};
	});

	return dedupeBy(files, (file) => file.url);
}

export function extractFolderLinks(root: Document | Element = document): MoodleFolderLink[] {
	const contentRoot = findMoodleContentRoot(root);
	const links = Array.from(contentRoot.querySelectorAll<HTMLAnchorElement>("a[href]"));
	const precedingSectionTitles = createPrecedingSectionTitleLookup(contentRoot, links);
	const folders = links.filter(isFolderLink).map((link) => ({
		title: extractLinkTitle(link),
		url: normalizeUrl(link.href, root),
		sectionTitle: findSectionTitle(link, precedingSectionTitles.get(link) ?? null),
	}));

	return dedupeBy(folders, (folder) => folder.url);
}

export function extractPageText(root: Document | Element = document): string {
	const main = root.querySelector("main, #region-main, [role='main']") ?? root;
	const ignoredSelectors = "script, style, noscript, nav, header, footer";
	const clone = main.cloneNode(true) as Element;

	for (const ignored of clone.querySelectorAll(ignoredSelectors)) {
		ignored.remove();
	}

	return normalizeText(clone.textContent);
}

export function extractDashboardText(root: Document | Element = document): string {
	const dashboardBlocks = root.querySelectorAll(
		[
			"[data-fuzzy-dashboard-widget]",
			".block_timeline",
			".block_calendar_upcoming",
			".block_myoverview",
			"[data-region='event-list-content']",
			"[data-region='course-events-container']",
		].join(", "),
	);

	return normalizeText(
		Array.from(dashboardBlocks)
			.map((block) => block.textContent)
			.join("\n"),
	);
}

export function extractAssignmentHints(
	text: string,
	source: MoodleAssignmentHint["source"] = "page_text",
): MoodleAssignmentHint[] {
	const lines = normalizeText(text)
		.split(/\n+/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && ASSIGNMENT_KEYWORD_PATTERN.test(line));

	return dedupeBy(
		lines.map((line) => ({
			moodleAssignmentId: null,
			title: extractAssignmentTitle(line),
			dueText: extractDueText(line),
			sourceText: line,
			source,
			submitted: false,
			submissionAvailability: "unknown" as const,
			moodleUrl: null,
		})),
		(hint) => `${hint.source}:${hint.sourceText}`,
	);
}

export function detectSubmissionAvailability(
	sourceText: string,
): MoodleAssignmentHint["submissionAvailability"] {
	if (SUBMISSION_UNAVAILABLE_PATTERN.test(sourceText)) return "unavailable";
	if (SUBMISSION_AVAILABLE_PATTERN.test(sourceText)) return "available";
	return "unknown";
}

/**
 * Moodleのcourse-moduleリンクから、同期に使える安定ID付き課題だけを抽出する。
 * 文面だけの類似課題を同一視しないため、IDはURL/構造化属性からのみ取得する。
 */
export function extractStructuredAssignmentHints(
	root: Document | Element = document,
): MoodleAssignmentHint[] {
	const links = findMoodleAssignmentLinks(root);
	const hints = links.flatMap((link): MoodleAssignmentHint[] => {
		const url = normalizeUrl(link.href, root);
		const moodleAssignmentId = extractMoodleAssignmentId(link, url);
		if (!moodleAssignmentId) return [];

		const container =
			link.closest(
				[
					"[data-activityname]",
					"li.activity",
					".activity",
					"[data-region='event-list-item']",
					"[data-event-id]",
					".event",
				].join(", "),
			) ?? link;
		const sourceText = normalizeText(container.textContent);
		const structuredTitle = normalizeText(container.getAttribute("data-activityname"));
		const title = structuredTitle || extractLinkTitle(link);
		if (!title) return [];

		return [
			{
				moodleAssignmentId,
				title,
				dueText: extractDueText(sourceText),
				sourceText,
				source: isDashboardAssignment(link) ? "dashboard_widget" : "page_text",
				submitted: /(?:提出済み|提出しました|submitted|graded)/i.test(sourceText),
				submissionAvailability: detectSubmissionAvailability(sourceText),
				moodleUrl: normalizedAssignmentUrl(url),
			},
		];
	});

	return dedupeBy(hints, (hint) => hint.moodleAssignmentId ?? "");
}

function normalizedAssignmentUrl(url: string): string | null {
	const parsed = safeUrl(url);
	if (!parsed || !/\/mod\/(?:assign|quiz)\/view\.php$/i.test(parsed.pathname)) return null;
	parsed.hash = "";
	return parsed.href;
}

/**
 * 表示中の課題リンクがすべて安定ID付きhintへ変換されたかを確認する。
 * 1件でも取りこぼしたsnapshotは完全一覧ではないため、removed判定へ送らない。
 */
export function hasCompleteAssignmentHintExtraction(
	root: Document | Element,
	hints: readonly MoodleAssignmentHint[],
): boolean {
	const extractedIds = new Set(
		hints.flatMap((hint) => (hint.moodleAssignmentId ? [hint.moodleAssignmentId] : [])),
	);
	for (const link of findMoodleAssignmentLinks(root)) {
		const stableId = extractMoodleAssignmentId(link, normalizeUrl(link.href, root));
		if (!stableId || !extractedIds.has(stableId)) return false;
	}
	return true;
}

function findMoodleAssignmentLinks(root: Document | Element): HTMLAnchorElement[] {
	return Array.from(
		findMoodleContentRoot(root).querySelectorAll<HTMLAnchorElement>("a[href]"),
	).filter((link) => MOODLE_ASSIGNMENT_PATTERN.test(normalizeUrl(link.href, root)));
}

function extractMoodleAssignmentId(link: HTMLAnchorElement, url: string): string | null {
	const parsed = safeUrl(url);
	const moduleName = parsed?.pathname.match(MOODLE_ASSIGNMENT_PATTERN)?.[1]?.toLowerCase();
	if (!moduleName) return null;

	const container = link.closest<HTMLElement>(
		"[data-cmid], [data-activityid], [data-course-module-id], [data-event-id]",
	);
	const stableId =
		parsed?.searchParams.get("id") ??
		container?.dataset.cmid ??
		container?.dataset.activityid ??
		container?.dataset.courseModuleId ??
		null;
	if (!stableId || !/^[A-Za-z0-9._:-]{1,120}$/.test(stableId)) return null;
	return `${moduleName}:${stableId}`;
}

function isDashboardAssignment(link: HTMLAnchorElement): boolean {
	return Boolean(
		link.closest(
			[
				"[data-fuzzy-dashboard-widget]",
				".block_timeline",
				".block_calendar_upcoming",
				".block_myoverview",
				"[data-region='event-list-content']",
				"[data-region='course-events-container']",
			].join(", "),
		),
	);
}

function isFileLikeLink(link: HTMLAnchorElement): boolean {
	if (isIgnoredCourseLink(link)) return false;

	const href = link.href;
	const label = extractLinkTitle(link);
	const mimeHint = extractMimeHint(link, href);

	// Moodle resource URLs can point to a file or an HTML page. Only include them
	// when metadata identifies a non-page file type, or keep them temporarily so
	// snapshotCollector can resolve the authenticated response headers.
	if (MOODLE_RESOURCE_PATTERN.test(href)) {
		return !WEB_PAGE_MIME_HINTS.has(mimeHint ?? "");
	}

	return (
		!WEB_PAGE_MIME_HINTS.has(mimeHint ?? "") &&
		(MOODLE_DIRECT_FILE_PATTERN.test(href) ||
			hasSupportedFileExtension(href) ||
			hasSupportedFileExtension(label))
	);
}

function isFolderLink(link: HTMLAnchorElement): boolean {
	return !isIgnoredCourseLink(link) && MOODLE_FOLDER_PATTERN.test(link.href);
}

function findMoodleContentRoot(root: Document | Element): Document | Element {
	return (
		root.querySelector(
			[
				".course-content",
				"#region-main .course-content",
				"#region-main",
				"main",
				"[role='main']",
			].join(", "),
		) ?? root
	);
}

function isIgnoredCourseLink(link: HTMLAnchorElement): boolean {
	return link.closest(NON_COURSE_LINK_CONTAINER_SELECTOR) !== null;
}

function extractLinkTitle(link: HTMLAnchorElement): string {
	const clone = link.cloneNode(true) as HTMLElement;
	for (const hidden of clone.querySelectorAll(".accesshide, .sr-only")) {
		hidden.remove();
	}

	return normalizeText(clone.textContent) || normalizeText(link.getAttribute("title")) || link.href;
}

function extractFileTitle(link: HTMLAnchorElement, url: string, mimeHint: string | null): string {
	const title = extractLinkTitle(link);
	if (!mimeHint || hasSupportedFileExtension(title)) return title;

	const fileName = extractFileNameFromUrl(url);
	if (fileName && hasSupportedFileExtension(fileName)) return fileName;

	return `${title}.${mimeHint}`;
}

function extractFileNameFromUrl(url: string): string | null {
	const pathname = safeDecodeURIComponent(safeUrl(url)?.pathname ?? "");
	const fileName = pathname.split("/").pop() ?? "";
	return fileName && fileName !== "pluginfile.php" ? fileName : null;
}

function findSectionTitle(element: Element, precedingSectionTitle: string | null): string | null {
	const sectionContainer = element.closest(MOODLE_SECTION_CONTAINER_SELECTOR);

	if (sectionContainer) {
		const sectionTitle = sectionContainerTitle(sectionContainer);
		if (sectionTitle) return sectionTitle;
	}

	// 活動名・ファイル名・容量は所属セクションではないため、代替値には使わない。
	return precedingSectionTitle;
}

/**
 * 見出しとリンクをDOM順に一度だけ走査し、親子関係を持たないテーマ向けの
 * 「直前のセクション見出し」をリンクごとに記録する。
 */
function createPrecedingSectionTitleLookup(
	root: Document | Element,
	links: HTMLAnchorElement[],
): Map<HTMLAnchorElement, string | null> {
	const linkSet = new Set<Element>(links);
	const titles = new Map<HTMLAnchorElement, string | null>();
	let currentSectionTitle: string | null = null;
	const candidates = root.querySelectorAll(
		`${MOODLE_SECTION_CONTAINER_SELECTOR}, ${MOODLE_SECTION_HEADING_SELECTOR}, a[href]`,
	);

	for (const candidate of candidates) {
		if (linkSet.has(candidate)) {
			titles.set(candidate as HTMLAnchorElement, currentSectionTitle);
			continue;
		}
		const sectionTitle = sectionMarkerTitle(candidate);
		if (sectionTitle) currentSectionTitle = sectionTitle;
	}
	return titles;
}

function sectionMarkerTitle(candidate: Element): string | null {
	if (candidate.closest(MOODLE_ACTIVITY_SELECTOR)) return null;
	if (candidate.matches(MOODLE_SECTION_CONTAINER_SELECTOR)) {
		return sectionContainerTitle(candidate);
	}
	return candidate.matches(MOODLE_SECTION_HEADING_SELECTOR) ? textOf(candidate) : null;
}

function sectionContainerTitle(sectionContainer: Element): string | null {
	const heading = findSectionHeading(sectionContainer);
	const labelledBy = sectionContainer.getAttribute("aria-labelledby")?.split(/\s+/) ?? [];
	const labelledTitles = labelledBy.map((id) =>
		textOf(sectionContainer.ownerDocument.getElementById(id)),
	);
	return firstMeaningful([
		textOf(heading),
		...labelledTitles,
		normalizeText(sectionContainer.getAttribute("data-section-name")),
	]);
}

function findSectionHeading(sectionContainer: Element): Element | null {
	const candidates = sectionContainer.querySelectorAll(
		`${MOODLE_SECTION_HEADING_SELECTOR}, h2, h3, h4`,
	);
	return (
		Array.from(candidates).find(
			(candidate) =>
				!candidate.closest(MOODLE_ACTIVITY_SELECTOR) &&
				candidate.closest(MOODLE_SECTION_CONTAINER_SELECTOR) === sectionContainer,
		) ?? null
	);
}

function extractMoodleFileId(url: string): string | null {
	const match = url.match(/\/pluginfile\.php\/(\d+)\//);
	return match?.[1] ?? null;
}

function extractMimeHint(link: HTMLAnchorElement, url: string): string | null {
	const pathname = safeDecodeURIComponent(safeUrl(url)?.pathname ?? url);
	const fromUrl = fileExtensionFromName(pathname);
	if (fromUrl) return fromUrl;
	return extractMoodleActivityMimeHint(link);
}

function extractMoodleActivityMimeHint(link: HTMLAnchorElement): string | null {
	const activity = link.closest(
		".activity-item, li.activity, .activity, [data-region='activity-card']",
	);
	const activityHint = resolveMoodleActivityMimeHint(
		activity?.querySelector(".activitybadge, .badge")?.textContent,
		activity?.querySelector<HTMLImageElement>("[data-region='activity-icon'], img.activityicon")
			?.src,
	);
	if (activityHint) return activityHint;

	for (const scope of fileTypeScopes(link)) {
		// pluginfile.php や resource/view.php は URL から拡張子を取り出せない。
		// Moodle のテーマ差分を吸収するため、構造化属性とアイコンURLを確認する。
		const elements = [
			scope,
			...scope.querySelectorAll<HTMLElement>(
				"[data-region='activity-icon'], [class*='activityicon'], [class*='file'], img, svg, i",
			),
		];
		for (const element of elements) {
			const labels = [
				normalizeText(element.getAttribute("alt")),
				normalizeText(element.getAttribute("aria-label")),
				normalizeText(element.getAttribute("title")),
				normalizeText(element.getAttribute("data-file-type")),
				normalizeText(element.getAttribute("data-mimetype")),
			];
			for (const label of labels) {
				const mimeHint = normalizeFileTypeHint(label);
				if (mimeHint) return mimeHint;
			}
			const source = element.getAttribute("src") ?? "";
			const mimeHint = fileTypeFromMoodleIconUrl(source);
			if (mimeHint) return mimeHint;
		}
	}

	return null;
}

function fileTypeScopes(link: HTMLAnchorElement): Element[] {
	const candidates = [
		link,
		link.parentElement,
		link.closest(".activity-item, li.activity, .activity, [data-region='activity-card']"),
		link.closest("li, tr, .card, .resource, [role='listitem']"),
	];
	return candidates.filter((candidate): candidate is Element => candidate !== null);
}

/** MoodleアクティビティのバッジとアイコンURLからファイル種別を推定する。 */
export function resolveMoodleActivityMimeHint(
	badgeText: string | null | undefined,
	iconSrc: string | null | undefined,
): string | null {
	const badgeHint = normalizeFileTypeHint(badgeText);
	if (badgeHint) return badgeHint;
	return fileTypeFromMoodleIconUrl(iconSrc);
}

function extractAssignmentTitle(line: string): string {
	return line
		.replace(DUE_TEXT_PATTERN, "")
		.replace(/^(課題|レポート|提出|締切|期限)[:：\s]*/i, "")
		.trim()
		.slice(0, 80);
}

function extractDueText(line: string): string | null {
	const match = line.match(DUE_TEXT_PATTERN);
	return match?.[1]?.trim() ?? null;
}

function normalizeUrl(url: string, root: Document | Element): string {
	try {
		return new URL(url, getBaseUri(root)).toString();
	} catch {
		return url;
	}
}

function safeDecodeURIComponent(value: string): string {
	// Moodleが不正な%エンコードを含むリンクを出すと decodeURIComponent は例外を投げるため、
	// 失敗時は元の文字列をそのまま使い、スナップショット収集全体が落ちないようにする。
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function safeUrl(url: string): URL | null {
	try {
		return new URL(url);
	} catch {
		return null;
	}
}

function getBaseUri(root: Document | Element): string {
	return isDocumentRoot(root) ? root.baseURI : root.ownerDocument.baseURI;
}

function isDocumentRoot(root: Document | Element): root is Document {
	return root.nodeType === 9;
}

function textOf(element: Element | null): string {
	return normalizeText(element?.textContent);
}

function normalizeText(value: string | null | undefined): string {
	return (value ?? "")
		.replace(/\u00a0/g, " ")
		.replace(/[ \t]+/g, " ")
		.replace(/\n[ \t]+/g, "\n")
		.trim();
}

function firstMeaningful(values: Array<string | null | undefined>): string | null {
	return values.map((value) => normalizeText(value)).find((value) => value.length > 0) ?? null;
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
	return Array.from(new Set(values.map((value) => normalizeText(value)).filter(Boolean)));
}

function dedupeBy<T>(items: T[], keyOf: (item: T) => string): T[] {
	const seen = new Set<string>();
	return items.filter((item) => {
		const key = keyOf(item);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
