import { boundedParallelMap } from "../boundedParallelMap";
import {
	fileExtensionFromName,
	fileNameFromContentDisposition,
	hasSupportedFileExtension,
	normalizeFileTypeHint,
} from "./fileType";
import { isHtmlResponse, readLimitedResponseText } from "./limitedResponse";
// Moodleページのスナップショット収集（issue48）。
// ./pageSnapshot.ts が「渡されたDOMの解析」を担うのに対し、このモジュールは
// フォルダページの追加フェッチを含む収集フロー全体と、失敗時のフォールバックを担う。
import {
	type MoodleFileLink,
	type MoodleFolderLink,
	type MoodlePageSnapshot,
	collectMoodlePageSnapshot,
	extractFileLinks,
	extractFolderLinks,
} from "./pageSnapshot";

/**
 * Moodleのフォルダ（/mod/folder/view.php）を追加でたどる深さの上限。
 * 授業ページ→フォルダ→サブフォルダ程度を想定し、無制限な探索はしない。
 */
const MAX_FOLDER_DEPTH = 2;
const MAX_FOLDER_FETCH_CONCURRENCY = 4;
const MAX_NESTED_FOLDER_PAGES = 50;
const MAX_MIME_HINT_REQUESTS = 20;
const MAX_MIME_HINT_CONCURRENCY = 4;
const MOODLE_REQUEST_TIMEOUT_MS = 4_000;
const MAX_FOLDER_HTML_BYTES = 2 * 1024 * 1024;
const MOODLE_RESOURCE_PATTERN = /\/mod\/resource\/view\.php/i;

export interface ResolvedMoodleFileMetadata {
	url: string;
	mimeHint: string;
	fileName: string | null;
}

const mimeHintCache = new Map<string, Promise<ResolvedMoodleFileMetadata | null>>();

export interface MoodleSnapshotCollectionOptions {
	resolveMimeHints?: boolean;
}

export interface MimeHintResolutionOptions {
	fetcher?: typeof fetch;
	origin?: string;
	maxRequests?: number;
	concurrency?: number;
	timeoutMs?: number;
	cache?: Map<string, Promise<ResolvedMoodleFileMetadata | null>>;
}

export function createEmptyMoodlePageSnapshot(): MoodlePageSnapshot {
	return {
		moodleCourseId: null,
		courseName: null,
		academicYear: null,
		term: null,
		sectionTitle: null,
		breadcrumbs: [],
		files: [],
		pageText: "",
		dashboardText: "",
		assignmentHints: [],
		collectedAt: new Date().toISOString(),
	};
}

/** 解析に失敗してもページ側の動作を壊さないよう、空のスナップショットへフォールバックする。 */
export function safeCollectMoodlePageSnapshot(root: Document = document): MoodlePageSnapshot {
	try {
		return collectMoodlePageSnapshot(root);
	} catch (error) {
		console.error("[fuzzy] Moodleページ情報の取得に失敗しました", error);
		return createEmptyMoodlePageSnapshot();
	}
}

/** 表示中ページに加えて、Moodleフォルダ配下の資料も取得したスナップショットを返す。 */
export async function collectMoodlePageSnapshotWithNestedFolders(
	root: Document = document,
	options: MoodleSnapshotCollectionOptions = {},
): Promise<MoodlePageSnapshot> {
	const snapshot = safeCollectMoodlePageSnapshot(root);
	const nestedFiles = await collectNestedFolderFiles(root);
	const detectedFiles = dedupeFiles([...snapshot.files, ...nestedFiles]);
	const files =
		options.resolveMimeHints === false
			? detectedFiles
			: await resolveMissingMimeHints(detectedFiles);

	return {
		...snapshot,
		files,
		collectedAt: new Date().toISOString(),
	};
}

/** URLやテーマアイコンから判定できない資料は、Moodleが返すContent-Typeで補完する。 */
export async function resolveMissingMimeHints(
	files: MoodleFileLink[],
	options: MimeHintResolutionOptions = {},
): Promise<MoodleFileLink[]> {
	const origin = options.origin ?? currentOrigin();
	const candidates = files
		.map((file, index) => ({ file, index }))
		.filter(
			({ file }) =>
				(!file.mimeHint || MOODLE_RESOURCE_PATTERN.test(file.url)) &&
				isSameOriginUrl(file.url, origin),
		)
		.slice(0, options.maxRequests ?? MAX_MIME_HINT_REQUESTS);
	if (candidates.length === 0) return files;

	const resolvedFiles = [...files];
	const unresolvedResourceIndexes = new Set<number>();
	const fetcher = options.fetcher ?? fetch;
	const cache = options.cache ?? mimeHintCache;
	const timeoutMs = options.timeoutMs ?? MOODLE_REQUEST_TIMEOUT_MS;
	let nextIndex = 0;

	async function runWorker(): Promise<void> {
		while (nextIndex < candidates.length) {
			const candidate = candidates[nextIndex++];
			if (!candidate) return;
			const metadata = await getCachedMimeHint(
				candidate.file.url,
				origin,
				fetcher,
				timeoutMs,
				cache,
			);
			if (metadata) {
				resolvedFiles[candidate.index] = applyResolvedMetadata(candidate.file, metadata);
			} else if (MOODLE_RESOURCE_PATTERN.test(candidate.file.url)) {
				unresolvedResourceIndexes.add(candidate.index);
			}
		}
	}

	const concurrency = Math.max(
		1,
		Math.min(options.concurrency ?? MAX_MIME_HINT_CONCURRENCY, candidates.length),
	);
	await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
	return resolvedFiles.filter(
		(file, index) =>
			!unresolvedResourceIndexes.has(index) &&
			!(MOODLE_RESOURCE_PATTERN.test(file.url) && file.mimeHint === null),
	);
}

function getCachedMimeHint(
	url: string,
	origin: string,
	fetcher: typeof fetch,
	timeoutMs: number,
	cache: Map<string, Promise<ResolvedMoodleFileMetadata | null>>,
): Promise<ResolvedMoodleFileMetadata | null> {
	const cached = cache.get(url);
	if (cached) return cached;
	const request = fetchMimeHint(url, origin, fetcher, timeoutMs).then((mimeHint) => {
		// 一時的な通信失敗やタイムアウトは固定化せず、明示的な再読み込みで再試行できるようにする。
		if (!mimeHint) cache.delete(url);
		return mimeHint;
	});
	cache.set(url, request);
	return request;
}

async function fetchMimeHint(
	url: string,
	origin: string,
	fetcher: typeof fetch,
	timeoutMs: number,
): Promise<ResolvedMoodleFileMetadata | null> {
	const head = await fetchMetadataResponse(url, "HEAD", fetcher, timeoutMs);
	const headMetadata = head ? metadataFromResponse(head, origin) : null;
	if (headMetadata && headMetadata.mimeHint !== "html") return headMetadata;

	const get = await fetchMetadataResponse(url, "GET", fetcher, timeoutMs);
	const getMetadata = get ? metadataFromResponse(get, origin) : null;
	if (getMetadata?.mimeHint === "html") return null;
	return getMetadata;
}

async function fetchMetadataResponse(
	url: string,
	method: "HEAD" | "GET",
	fetcher: typeof fetch,
	timeoutMs: number,
): Promise<Response | null> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetcher(url, {
			method,
			credentials: "include",
			headers: method === "GET" ? { Range: "bytes=0-4095" } : undefined,
			signal: controller.signal,
		});
		if (!response.ok) return null;
		if (method === "GET") void response.body?.cancel();
		return response;
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

function metadataFromResponse(
	response: Response,
	origin: string,
): ResolvedMoodleFileMetadata | null {
	const finalUrl = response.url || "";
	if (finalUrl && !isSameOriginUrl(finalUrl, origin)) return null;
	const contentTypeHint = normalizeFileTypeHint(response.headers.get("content-type"));
	const fileName = fileNameFromContentDisposition(response.headers.get("content-disposition"));
	const fileNameHint = fileExtensionFromName(fileName ?? "");
	const urlHint = fileExtensionFromName(finalUrl);
	const mimeHint = contentTypeHint ?? fileNameHint ?? urlHint;
	if (!mimeHint) return null;
	return { url: finalUrl || response.url, mimeHint, fileName };
}

function applyResolvedMetadata(
	file: MoodleFileLink,
	metadata: ResolvedMoodleFileMetadata,
): MoodleFileLink {
	const title = metadata.fileName
		? metadata.fileName
		: hasSupportedFileExtension(file.title)
			? file.title
			: `${file.title}.${metadata.mimeHint}`;
	return {
		...file,
		title,
		url: metadata.url || file.url,
		mimeHint: metadata.mimeHint,
	};
}

async function collectNestedFolderFiles(root: Document | Element): Promise<MoodleFileLink[]> {
	type FolderTask = { folder: MoodleFolderLink; depth: number; inheritedSection: string };
	const seenFolders = new Set<string>();
	const queue: FolderTask[] = [];
	for (const folder of extractFolderLinks(root)) {
		if (!isSameOriginUrl(folder.url) || seenFolders.has(folder.url)) continue;
		seenFolders.add(folder.url);
		queue.push({ folder, depth: 0, inheritedSection: folder.sectionTitle ?? folder.title });
	}

	const collected: MoodleFileLink[] = [];
	let fetchedPages = 0;
	while (queue.length > 0 && fetchedPages < MAX_NESTED_FOLDER_PAGES) {
		const remaining = MAX_NESTED_FOLDER_PAGES - fetchedPages;
		const batch = queue.splice(0, remaining);
		fetchedPages += batch.length;
		const results = await boundedParallelMap(batch, MAX_FOLDER_FETCH_CONCURRENCY, async (task) => {
			try {
				const folderDocument = await fetchMoodleDocument(task.folder.url);
				return { task, folderDocument };
			} catch (error) {
				console.warn("[fuzzy] Moodleフォルダ内の資料取得に失敗しました", {
					url: task.folder.url,
					error,
				});
				return null;
			}
		});
		for (const result of results) {
			if (!result) continue;
			collected.push(
				...withSectionFallback(
					extractFileLinks(result.folderDocument),
					result.task.inheritedSection,
				),
			);
			if (result.task.depth + 1 >= MAX_FOLDER_DEPTH) continue;
			for (const folder of extractFolderLinks(result.folderDocument)) {
				if (!isSameOriginUrl(folder.url) || seenFolders.has(folder.url)) continue;
				seenFolders.add(folder.url);
				queue.push({
					folder,
					depth: result.task.depth + 1,
					inheritedSection: folder.sectionTitle || folder.title || result.task.inheritedSection,
				});
			}
		}
	}

	return dedupeFiles(collected);
}

function withSectionFallback(
	files: MoodleFileLink[],
	sectionTitle: string | null,
): MoodleFileLink[] {
	return files.map((file) => (file.sectionTitle ? file : { ...file, sectionTitle }));
}

async function fetchMoodleDocument(url: string): Promise<Document> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), MOODLE_REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(url, { credentials: "include", signal: controller.signal });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const responseUrl = response.url || url;
		if (!isSameOriginUrl(responseUrl, new URL(url).origin) || !isHtmlResponse(response)) {
			throw new Error("Moodle外またはHTML以外の応答です");
		}

		const html = await readLimitedResponseText(response, MAX_FOLDER_HTML_BYTES);
		if (html === null) throw new Error("Moodleフォルダーページが上限を超えています");
		const parsed = new DOMParser().parseFromString(html, "text/html");
		// 相対リンクをフォルダページ基準で解決できるよう、baseを差し込む
		const base = parsed.createElement("base");
		base.href = responseUrl;
		parsed.head.prepend(base);
		return parsed;
	} finally {
		clearTimeout(timeout);
	}
}

function isSameOriginUrl(url: string, origin = currentOrigin()): boolean {
	try {
		return Boolean(origin) && new URL(url).origin === origin;
	} catch {
		return false;
	}
}

function currentOrigin(): string {
	return typeof location === "undefined" ? "" : location.origin;
}

function dedupeFiles(files: MoodleFileLink[]): MoodleFileLink[] {
	const seen = new Set<string>();
	return files.filter((file) => {
		if (seen.has(file.url)) return false;
		seen.add(file.url);
		return true;
	});
}
