import type { MoodleFileMeta } from "@fuzzy/shared";
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
	title: string;
	dueText: string | null;
	sourceText: string;
	source: "page_text" | "dashboard_widget";
}

export interface MoodlePageSnapshot {
	courseName: string | null;
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
const WEB_PAGE_MIME_HINTS = new Set(["htm", "html"]);
const ASSIGNMENT_KEYWORD_PATTERN =
	/(課題|レポート|提出|締切|期限|小テスト|quiz|assignment|report|due)/i;
const DUE_TEXT_PATTERN =
	/(?:提出期限|締切|期限|due\s*date|due)[:：\s]*(\d{4}[/-]\d{1,2}[/-]\d{1,2}(?:\s+\d{1,2}:\d{2})?|[0-9０-９]{1,2}月[0-9０-９]{1,2}日(?:\s*[0-9０-９]{1,2}[:：][0-9０-９]{2})?|[^。．\n]{1,40})/i;
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
		courseName: extractCourseName(root),
		sectionTitle: extractSectionTitle(root),
		breadcrumbs: extractBreadcrumbs(root),
		files: extractFileLinks(root),
		pageText,
		dashboardText,
		assignmentHints: [
			...extractAssignmentHints(pageText, "page_text"),
			...extractAssignmentHints(dashboardText, "dashboard_widget"),
		],
		collectedAt: new Date().toISOString(),
	};
}

export function extractCourseName(root: Document | Element = document): string | null {
	const candidates = [
		textOf(root.querySelector(".page-header-headings h1")),
		textOf(root.querySelector("h1")),
		...extractBreadcrumbs(root).slice(-2),
	];

	return firstMeaningful(candidates);
}

export function extractSectionTitle(root: Document | Element = document): string | null {
	const candidates = [
		textOf(root.querySelector("[data-section-name]")),
		textOf(root.querySelector(".sectionname")),
		textOf(root.querySelector("li.section.current h3, li.section.current h4")),
		textOf(root.querySelector("h2, h3")),
	];

	return firstMeaningful(candidates);
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
	const files = links.filter(isFileLikeLink).map((link) => {
		const url = normalizeUrl(link.href, root);
		const mimeHint = extractMimeHint(link, url);
		return {
			title: extractFileTitle(link, url, mimeHint),
			url,
			moodleFileId: extractMoodleFileId(url),
			sectionTitle: findSectionTitle(link),
			mimeHint,
		};
	});

	return dedupeBy(files, (file) => file.url);
}

export function extractFolderLinks(root: Document | Element = document): MoodleFolderLink[] {
	const contentRoot = findMoodleContentRoot(root);
	const links = Array.from(contentRoot.querySelectorAll<HTMLAnchorElement>("a[href]"));
	const folders = links.filter(isFolderLink).map((link) => ({
		title: extractLinkTitle(link),
		url: normalizeUrl(link.href, root),
		sectionTitle: findSectionTitle(link),
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
			title: extractAssignmentTitle(line),
			dueText: extractDueText(line),
			sourceText: line,
			source,
		})),
		(hint) => `${hint.source}:${hint.sourceText}`,
	);
}

function isFileLikeLink(link: HTMLAnchorElement): boolean {
	if (isIgnoredCourseLink(link)) return false;

	const href = link.href;
	const label = extractLinkTitle(link);
	const mimeHint = extractMimeHint(link, href);

	// Moodle resource URLs can point to a file or an HTML page. Only include them
	// when the activity metadata identifies a non-page file type.
	if (MOODLE_RESOURCE_PATTERN.test(href)) {
		return (
			!WEB_PAGE_MIME_HINTS.has(mimeHint ?? "") &&
			(mimeHint !== null || hasSupportedFileExtension(href) || hasSupportedFileExtension(label))
		);
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

function findSectionTitle(element: Element): string | null {
	const sectionContainer = element.closest(
		"[data-section-name], li.section, .section, .course-section",
	);

	if (sectionContainer) {
		const explicitName = normalizeText(sectionContainer.getAttribute("data-section-name"));
		const heading = sectionContainer.querySelector("h2, h3, h4, .sectionname");
		const sectionTitle = firstMeaningful([explicitName, textOf(heading)]);
		if (sectionTitle) return sectionTitle;
	}

	const activityContainer = element.closest("li.activity, .activity, [data-activityname]");
	const activityName = normalizeText(activityContainer?.getAttribute("data-activityname"));
	const activityHeading = activityContainer?.querySelector(
		".activityname, .instancename, [data-activityname]",
	);
	const breadcrumbFallback = extractBreadcrumbs(element.ownerDocument).slice(-1)[0];

	return firstMeaningful([activityName, textOf(activityHeading ?? null), breadcrumbFallback]);
}

function extractMoodleFileId(url: string): string | null {
	const match = url.match(/\/pluginfile\.php\/(\d+)\//);
	return match?.[1] ?? null;
}

function extractMimeHint(link: HTMLAnchorElement, url: string): string | null {
	const fromMoodleActivity = extractMoodleActivityMimeHint(link);
	if (fromMoodleActivity) return fromMoodleActivity;

	const pathname = safeDecodeURIComponent(safeUrl(url)?.pathname ?? url);
	return fileExtensionFromName(pathname);
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
	return root instanceof Document ? root.baseURI : root.ownerDocument.baseURI;
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
