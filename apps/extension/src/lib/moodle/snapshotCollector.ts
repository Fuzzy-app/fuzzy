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

	return {
		...snapshot,
		files: dedupeFiles([...snapshot.files, ...nestedFiles]),
		collectedAt: new Date().toISOString(),
	};
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
