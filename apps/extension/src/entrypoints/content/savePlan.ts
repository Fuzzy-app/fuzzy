import {
	type FuzzyApiClient,
	type SaveSuggestion,
	canonicalWindowsPath,
	inferSaveRoot,
	normalizeRelativeSavePath,
	normalizeWindowsPath,
} from "@fuzzy/shared";
import type { MoodleFileLink, MoodlePageSnapshot } from "../../lib/moodle/pageSnapshot";

export type FileSuggestions = Map<string, SaveSuggestion[]>;
export type SelectedFilePaths = Map<string, string>;

export interface SaveDestinationGroup {
	key: string;
	path: string;
	relativePath: string;
	files: MoodleFileLink[];
}

interface ManualDestination {
	path: string;
	relativePath: string;
}

/** 資料ごとに保存先候補を取得する。先頭資料だけで全件を代表させない。 */
export async function loadFileSuggestions(
	api: Pick<FuzzyApiClient, "suggestSavePath">,
	snapshot: MoodlePageSnapshot,
): Promise<FileSuggestions> {
	const entries = await Promise.all(
		snapshot.files.map(async (file) => {
			const suggestions = await api.suggestSavePath({
				course: {
					name: snapshot.courseName,
					sectionTitle: snapshot.sectionTitle,
					breadcrumbs: snapshot.breadcrumbs,
				},
				fileMeta: file,
			});
			return [fileId(file), rankSuggestions(suggestions)] as const;
		}),
	);
	return new Map(entries);
}

export function createSelectedFilePaths(suggestions: FileSuggestions): SelectedFilePaths {
	return new Map(
		[...suggestions.entries()]
			.map(([id, items]) => [id, items[0]?.path] as const)
			.filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
	);
}

/** 選択資料を、確認済みの保存先が同じもの同士でまとめる。 */
export function buildSaveDestinationGroups(
	files: MoodleFileLink[],
	selectedFileIds: ReadonlySet<string>,
	suggestions: FileSuggestions,
	selectedPaths: SelectedFilePaths,
	manualDestination: ManualDestination | null = null,
): SaveDestinationGroup[] {
	const groups = new Map<string, SaveDestinationGroup>();
	for (const file of files) {
		const id = fileId(file);
		if (!selectedFileIds.has(id)) continue;
		const destination = manualDestination ?? selectedDestination(file, suggestions, selectedPaths);
		if (!destination) continue;
		const path = normalizeWindowsPath(destination.path);
		const key = canonicalWindowsPath(path);
		const existing = groups.get(key);
		if (existing) existing.files.push(file);
		else groups.set(key, { key, path, relativePath: destination.relativePath, files: [file] });
	}
	return [...groups.values()];
}

/** グループ内の全資料に共通している保存先候補を返す。 */
export function commonGroupSuggestions(
	group: SaveDestinationGroup,
	suggestions: FileSuggestions,
): SaveSuggestion[] {
	const first = suggestions.get(fileId(group.files[0] as MoodleFileLink)) ?? [];
	return first.filter((candidate) =>
		group.files.every((file) =>
			(suggestions.get(fileId(file)) ?? []).some(
				(item) => canonicalWindowsPath(item.path) === canonicalWindowsPath(candidate.path),
			),
		),
	);
}

export function saveRootFromSuggestions(suggestions: FileSuggestions): string | null {
	for (const items of suggestions.values()) {
		for (const suggestion of items) {
			const root = inferSaveRoot(suggestion.path, suggestion.relativePath);
			if (root) return root;
		}
	}
	return null;
}

export function fileId(file: MoodleFileLink): string {
	return file.url;
}

export function rankSuggestions(suggestions: SaveSuggestion[]): SaveSuggestion[] {
	const unique = new Map<string, SaveSuggestion>();
	for (const suggestion of suggestions) {
		if (!suggestion.path.trim()) continue;
		const relativePath = normalizeRelativeSavePath(suggestion.relativePath);
		if (relativePath === null) continue;
		const normalized = {
			...suggestion,
			path: normalizeWindowsPath(suggestion.path),
			relativePath,
		};
		if (!inferSaveRoot(normalized.path, normalized.relativePath)) continue;
		const key = canonicalWindowsPath(normalized.path);
		const current = unique.get(key);
		if (!current || normalized.confidence > current.confidence) unique.set(key, normalized);
	}
	return [...unique.values()].sort((a, b) => b.confidence - a.confidence);
}

function selectedDestination(
	file: MoodleFileLink,
	suggestions: FileSuggestions,
	selectedPaths: SelectedFilePaths,
): ManualDestination | null {
	const id = fileId(file);
	const path = selectedPaths.get(id);
	if (!path) return null;
	const suggestion = (suggestions.get(id) ?? []).find(
		(candidate) => canonicalWindowsPath(candidate.path) === canonicalWindowsPath(path),
	);
	return {
		path,
		relativePath: suggestion?.relativePath ?? normalizeWindowsPath(path),
	};
}
