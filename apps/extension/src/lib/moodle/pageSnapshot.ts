export interface MoodleFileLink {
	title: string;
	url: string;
	moodleFileId: string | null;
	sectionTitle: string | null;
	mimeHint: string | null;
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

const FILE_EXTENSION_PATTERN =
	/\.(pdf|docx?|pptx?|xlsx?|csv|txt|zip|7z|rar|png|jpe?g|gif)(?:$|[?#])/i;
const MOODLE_FILE_PATTERN =
	/\/pluginfile\.php\/|\/mod\/resource\/view\.php|\/mod\/folder\/view\.php/i;
const ASSIGNMENT_KEYWORD_PATTERN =
	/(課題|レポート|提出|締切|期限|小テスト|quiz|assignment|report|due)/i;
const DUE_TEXT_PATTERN =
	/(?:提出期限|締切|期限|due\s*date|due)[:：\s]*(\d{4}[/-]\d{1,2}[/-]\d{1,2}(?:\s+\d{1,2}:\d{2})?|[0-9０-９]{1,2}月[0-9０-９]{1,2}日(?:\s*[0-9０-９]{1,2}[:：][0-9０-９]{2})?|[^。．\n]{1,40})/i;

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
	const links = Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"));
	const files = links.filter(isFileLikeLink).map((link) => {
		const url = normalizeUrl(link.href, root);
		return {
			title: extractLinkTitle(link),
			url,
			moodleFileId: extractMoodleFileId(url),
			sectionTitle: findSectionTitle(link),
			mimeHint: extractMimeHint(url),
		};
	});

	return dedupeBy(files, (file) => file.url);
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
	const href = link.href;
	const label = extractLinkTitle(link);
	return (
		MOODLE_FILE_PATTERN.test(href) ||
		FILE_EXTENSION_PATTERN.test(href) ||
		FILE_EXTENSION_PATTERN.test(label)
	);
}

function extractLinkTitle(link: HTMLAnchorElement): string {
	const clone = link.cloneNode(true) as HTMLElement;
	for (const hidden of clone.querySelectorAll(".accesshide, .sr-only")) {
		hidden.remove();
	}

	return normalizeText(clone.textContent) || normalizeText(link.getAttribute("title")) || link.href;
}

function findSectionTitle(element: Element): string | null {
	const container = element.closest(
		"[data-section-name], li.section, .section, .course-section, li.activity, .activity",
	);
	if (!container) return null;

	const explicitName = normalizeText(container.getAttribute("data-section-name"));
	const heading = container.querySelector("h2, h3, h4, .sectionname, .instancename");

	return firstMeaningful([explicitName, textOf(heading)]);
}

function extractMoodleFileId(url: string): string | null {
	const match = url.match(/\/pluginfile\.php\/(\d+)\//);
	return match?.[1] ?? null;
}

function extractMimeHint(url: string): string | null {
	const pathname = safeUrl(url)?.pathname ?? url;
	const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
	return match?.[1]?.toLowerCase() ?? null;
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
