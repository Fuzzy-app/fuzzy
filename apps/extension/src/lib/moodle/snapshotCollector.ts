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
const MIME_TYPE_HINTS: Record<string, string> = {
	"application/pdf": "pdf",
	"application/zip": "zip",
	"application/vnd.google-earth.kmz": "kmz",
	"application/vnd.google-earth.kml+xml": "kml",
	"application/gpx+xml": "gpx",
	"application/msword": "doc",
	"application/vnd.ms-excel": "xls",
	"application/vnd.ms-powerpoint": "ppt",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/gif": "gif",
};

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
): Promise<MoodlePageSnapshot> {
	const snapshot = safeCollectMoodlePageSnapshot(root);
	const nestedFiles = await collectNestedFolderFiles(root);
	const files = await resolveMissingMimeHints(dedupeFiles([...snapshot.files, ...nestedFiles]));

	return {
		...snapshot,
		files,
		collectedAt: new Date().toISOString(),
	};
}

/** URLやテーマアイコンから判定できない資料は、Moodleが返すContent-Typeで補完する。 */
async function resolveMissingMimeHints(files: MoodleFileLink[]): Promise<MoodleFileLink[]> {
	let requestCount = 0;
	return Promise.all(
		files.map(async (file) => {
			if (file.mimeHint || requestCount >= MAX_MIME_HINT_REQUESTS || !isSameOriginUrl(file.url)) {
				return file;
			}
			requestCount += 1;
			const mimeHint = await fetchMimeHint(file.url);
			return mimeHint ? { ...file, mimeHint } : file;
		}),
	);
}

async function fetchMimeHint(url: string): Promise<string | null> {
	try {
		const response = await fetch(url, { method: "HEAD", credentials: "include" });
		if (!response.ok) return null;

		const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase();
		if (contentType && MIME_TYPE_HINTS[contentType]) return MIME_TYPE_HINTS[contentType];

		const disposition = response.headers.get("content-disposition") ?? "";
		return disposition.match(/\.([a-z0-9]{1,10})(?:["';]|$)/i)?.[1]?.toLowerCase() ?? null;
	} catch {
		return null;
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
	const response = await fetch(url, { credentials: "include" });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);

	const html = await response.text();
	const parsed = new DOMParser().parseFromString(html, "text/html");
	// 相対リンクをフォルダページ基準で解決できるよう、baseを差し込む
	const base = parsed.createElement("base");
	base.href = url;
	parsed.head.prepend(base);
	return parsed;
}

function isSameOriginUrl(url: string): boolean {
	try {
		return new URL(url).origin === location.origin;
	} catch {
		return false;
	}
}

function dedupeFiles(files: MoodleFileLink[]): MoodleFileLink[] {
	const seen = new Set<string>();
	return files.filter((file) => {
		if (seen.has(file.url)) return false;
		seen.add(file.url);
		return true;
	});
}
