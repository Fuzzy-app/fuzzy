import { fileExtensionFromContentDisposition, normalizeFileTypeHint } from "./fileType";
// Moodleページのスナップショット収集（issue48）。
// ./pageSnapshot.ts が「渡されたDOMの解析」を担うのに対し、このモジュールは
// フォルダページの追加フェッチを含む収集フロー全体と、失敗時のフォールバックを担う。
import {
	type MoodleFileLink,
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
const MAX_MIME_HINT_REQUESTS = 20;
const MAX_MIME_HINT_CONCURRENCY = 4;
const MOODLE_REQUEST_TIMEOUT_MS = 4_000;
const mimeHintCache = new Map<string, Promise<string | null>>();

export interface MoodleSnapshotCollectionOptions {
	resolveMimeHints?: boolean;
}

export interface MimeHintResolutionOptions {
	fetcher?: typeof fetch;
	origin?: string;
	maxRequests?: number;
	concurrency?: number;
	timeoutMs?: number;
	cache?: Map<string, Promise<string | null>>;
}

export function createEmptyMoodlePageSnapshot(): MoodlePageSnapshot {
	return {
		courseName: null,
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
		.filter(({ file }) => !file.mimeHint && isSameOriginUrl(file.url, origin))
		.slice(0, options.maxRequests ?? MAX_MIME_HINT_REQUESTS);
	if (candidates.length === 0) return files;

	const resolvedFiles = [...files];
	const fetcher = options.fetcher ?? fetch;
	const cache = options.cache ?? mimeHintCache;
	const timeoutMs = options.timeoutMs ?? MOODLE_REQUEST_TIMEOUT_MS;
	let nextIndex = 0;

	async function runWorker(): Promise<void> {
		while (nextIndex < candidates.length) {
			const candidate = candidates[nextIndex++];
			if (!candidate) return;
			const mimeHint = await getCachedMimeHint(candidate.file.url, fetcher, timeoutMs, cache);
			if (mimeHint) resolvedFiles[candidate.index] = { ...candidate.file, mimeHint };
		}
	}

	const concurrency = Math.max(
		1,
		Math.min(options.concurrency ?? MAX_MIME_HINT_CONCURRENCY, candidates.length),
	);
	await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
	return resolvedFiles;
}

function getCachedMimeHint(
	url: string,
	fetcher: typeof fetch,
	timeoutMs: number,
	cache: Map<string, Promise<string | null>>,
): Promise<string | null> {
	const cached = cache.get(url);
	if (cached) return cached;
	const request = fetchMimeHint(url, fetcher, timeoutMs).then((mimeHint) => {
		// 一時的な通信失敗やタイムアウトは固定化せず、明示的な再読み込みで再試行できるようにする。
		if (!mimeHint) cache.delete(url);
		return mimeHint;
	});
	cache.set(url, request);
	return request;
}

async function fetchMimeHint(
	url: string,
	fetcher: typeof fetch,
	timeoutMs: number,
): Promise<string | null> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetcher(url, {
			method: "HEAD",
			credentials: "include",
			signal: controller.signal,
		});
		if (!response.ok) return null;

		const contentTypeHint = normalizeFileTypeHint(response.headers.get("content-type"));
		if (contentTypeHint) return contentTypeHint;

		return fileExtensionFromContentDisposition(response.headers.get("content-disposition"));
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

async function collectNestedFolderFiles(
	root: Document | Element,
	depth = 0,
	seenFolders = new Set<string>(),
): Promise<MoodleFileLink[]> {
	if (depth >= MAX_FOLDER_DEPTH) return [];

	const folders = extractFolderLinks(root).filter((folder) => {
		if (!isSameOriginUrl(folder.url) || seenFolders.has(folder.url)) return false;
		seenFolders.add(folder.url);
		return true;
	});

	const filesByFolder = await Promise.all(
		folders.map(async (folder) => {
			try {
				const folderDocument = await fetchMoodleDocument(folder.url);
				const inheritedSection = folder.sectionTitle ?? folder.title;
				const directFiles = withSectionFallback(extractFileLinks(folderDocument), inheritedSection);
				const nestedFiles = withSectionFallback(
					await collectNestedFolderFiles(folderDocument, depth + 1, seenFolders),
					inheritedSection,
				);
				return [...directFiles, ...nestedFiles];
			} catch (error) {
				console.warn("[fuzzy] Moodleフォルダ内の資料取得に失敗しました", {
					url: folder.url,
					error,
				});
				return [];
			}
		}),
	);

	return dedupeFiles(filesByFolder.flat());
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

		const html = await response.text();
		const parsed = new DOMParser().parseFromString(html, "text/html");
		// 相対リンクをフォルダページ基準で解決できるよう、baseを差し込む
		const base = parsed.createElement("base");
		base.href = url;
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
