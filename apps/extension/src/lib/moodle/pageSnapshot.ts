import type { MoodleFileMeta } from "@fuzzy/shared";

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

const FILE_EXTENSION_PATTERN =
	/\.(pdf|docx?|pptx?|xlsx?|csv|txt|zip|7z|rar|kmz|kml|gpx|png|jpe?g|gif)(?:$|[?#])/i;
const MOODLE_FILE_PATTERN = /\/pluginfile\.php\/|\/mod\/resource\/view\.php/i;
const MOODLE_FOLDER_PATTERN = /\/mod\/folder\/view\.php/i;
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
		return {
			title: extractLinkTitle(link),
			url,
			moodleFileId: extractMoodleFileId(url),
			sectionTitle: findSectionTitle(link),
			mimeHint: extractMimeHint(link, url),
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
	return (
		MOODLE_FILE_PATTERN.test(href) ||
		FILE_EXTENSION_PATTERN.test(href) ||
		FILE_EXTENSION_PATTERN.test(label)
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

function findSectionTitle(element: Element): string | null {
	const sectionContainer = element.closest(
		[
			"[data-section-name]",
			"[data-sectionid]",
			"[data-section-number]",
			"[data-region='section']",
			"[id^='section-']",
			"li.section",
			".course-section",
			".section",
		].join(", "),
	);

	if (sectionContainer) {
		const explicitName = normalizeText(sectionContainer.getAttribute("data-section-name"));
		const labelledBy = sectionContainer.getAttribute("aria-labelledby");
		const labelledElement = labelledBy ? element.ownerDocument.getElementById(labelledBy) : null;
		// activity 内の見出しはファイル名（例: "画像処理とは（7.6MB)"）なので、
		// セクションの回・項目名として扱わない。
		const heading = findSectionHeading(sectionContainer);
		const sectionTitle = firstMeaningful([
			textOf(heading ?? null),
			textOf(labelledElement),
			explicitName,
		]);
		if (sectionTitle) return sectionTitle;
	}

	const precedingSectionTitle = findPrecedingSectionTitle(element);
	if (precedingSectionTitle) return precedingSectionTitle;

	// 活動名やパンくずはファイル名・コース名になりやすく、資料の所属を表す
	// セクション題名には使わない。
	return null;
}

/**
 * テーマによっては資料とセクション見出しが親子にならないため、
 * 直前にある活動外のセクション見出しを所属先として使う。
 */
function findPrecedingSectionTitle(element: Element): string | null {
	const headings = Array.from(
		element.ownerDocument.querySelectorAll(
			[
				"[data-section-name]",
				".sectionname",
				".section-title",
				".course-section-header h2",
				".course-section-header h3",
				".course-section-header h4",
				"[data-region='section'] > header h2",
				"[data-region='section'] > header h3",
				"[id^='section-'] > header h2",
				"[id^='section-'] > header h3",
			].join(", "),
		),
	).filter(
		(candidate) =>
			!candidate.closest("li.activity, .activity, [data-activityname]") &&
			Boolean(candidate.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING),
	);

	const heading = headings.at(-1) ?? null;
	return firstMeaningful([
		normalizeText(heading?.getAttribute("data-section-name")),
		textOf(heading),
	]);
}

/** セクションを囲む要素の本文ではなく、見出し要素そのものを優先する。 */
function findSectionHeading(sectionContainer: Element): Element | null {
	const selectors = [
		"[data-section-name]",
		".sectionname",
		".section-title",
		".course-section-header h2, .course-section-header h3, .course-section-header h4",
		"header h2, header h3, header h4",
		"h2, h3, h4",
	];

	for (const selector of selectors) {
		const heading = Array.from(sectionContainer.querySelectorAll(selector)).find(
			(candidate) => !candidate.closest("li.activity, .activity, [data-activityname]"),
		);
		if (heading) return heading;
	}
	return null;
}

function extractMoodleFileId(url: string): string | null {
	const match = url.match(/\/pluginfile\.php\/(\d+)\//);
	return match?.[1] ?? null;
}

function extractMimeHint(link: HTMLAnchorElement, url: string): string | null {
	const fromMoodleActivity = extractMoodleActivityMimeHint(link);
	if (fromMoodleActivity) return fromMoodleActivity;

	const pathname = safeDecodeURIComponent(safeUrl(url)?.pathname ?? url);
	const fileName = pathname.split("/").pop() ?? pathname;
	const match = fileName.match(/\.([a-z0-9]{2,5})$/i);
	const extension = match?.[1]?.toLowerCase() ?? null;

	return extension === "php" ? null : extension;
}

function extractMoodleActivityMimeHint(link: HTMLAnchorElement): string | null {
	for (const scope of fileTypeScopes(link)) {
		// pluginfile.php や resource/view.php は URL から拡張子を取り出せない。
		// Moodle のテーマ差分を吸収するため、画像だけでなくアイコン文字・alt・クラス名も読む。
		const elements = [
			scope,
			...scope.querySelectorAll<HTMLElement>(
				"[data-region='activity-icon'], [class*='activityicon'], [class*='file'], img, svg, i",
			),
		];
		for (const element of elements) {
			const labels = [
				normalizeText(element.textContent),
				normalizeText(element.getAttribute("alt")),
				normalizeText(element.getAttribute("aria-label")),
				normalizeText(element.getAttribute("title")),
				normalizeText(element.getAttribute("data-file-type")),
				normalizeText(element.getAttribute("data-mimetype")),
				normalizeText(element.getAttribute("class")),
			];
			for (const label of labels) {
				const mimeHint = normalizeMimeLabel(label);
				if (mimeHint) return mimeHint;
			}

			const source = element.getAttribute("src") ?? "";
			const iconName = source.match(
				/\/(?:f|file)\/([a-z0-9]+)(?:-\d+)?(?:\.(?:svg|png|gif|webp))?(?:[?#]|$)/i,
			)?.[1];
			const mimeHint = normalizeMimeLabel(iconName ?? null);
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

function normalizeMimeLabel(value: string | null): string | null {
	const normalized = normalizeText(value).toLowerCase();
	if (!normalized) return null;

	const aliases: Record<string, string> = {
		pdf: "pdf",
		word: "docx",
		doc: "doc",
		docx: "docx",
		powerpoint: "pptx",
		ppt: "ppt",
		pptx: "pptx",
		excel: "xlsx",
		xls: "xls",
		xlsx: "xlsx",
		zip: "zip",
		kmz: "kmz",
		kml: "kml",
		gpx: "gpx",
	};

	if (aliases[normalized]) return aliases[normalized];
	if (/(word|ワード|文書)/i.test(normalized)) return "docx";
	if (/(powerpoint|パワーポイント|プレゼン)/i.test(normalized)) return "pptx";
	if (/(excel|エクセル|表計算)/i.test(normalized)) return "xlsx";
	if (/(pdf|ピーディーエフ)/i.test(normalized)) return "pdf";
	return null;
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
