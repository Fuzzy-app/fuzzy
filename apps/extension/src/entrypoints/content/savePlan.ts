import {
	type CourseFolderNameResolution,
	type FuzzyApiClient,
	type SaveFileFailure,
	type SaveSuggestion,
	canonicalWindowsPath,
	inferSaveRoot,
	normalizeRelativeSavePath,
	normalizeWindowsPath,
} from "@fuzzy/shared";
import { contextualMoodleCourseId } from "../../lib/moodle/assignmentSync";
import type { MoodleFileLink, MoodlePageSnapshot } from "../../lib/moodle/pageSnapshot";

export type FileSuggestions = Map<string, SaveSuggestion[]>;
export type SelectedFilePaths = Map<string, string>;

export interface FileSuggestionLoadResult {
	suggestions: FileSuggestions;
	failedFileIds: string[];
	firstError: unknown;
}

export type SaveSuggestionStatusKind = "no-files" | "all-failed" | "partial" | "no-candidates";

export interface SaveSuggestionStatus {
	kind: SaveSuggestionStatusKind;
	message: string;
	reviewRules: boolean;
	suggestedFileCount: number;
	unavailableFileCount: number;
}

export interface SaveDestinationGroup {
	key: string;
	path: string;
	relativePath: string;
	courseId: number | null;
	files: MoodleFileLink[];
}

/** 保存失敗の内訳を、利用者が次の操作を選べる文言へ変換する。 */
export function saveFailureMessage(
	savedCount: number,
	failures: readonly SaveFileFailure[],
): string | null {
	if (failures.length === 0) return null;
	const failedCount = failures.length;
	const codes = new Set(failures.map((failure) => failure.code));
	const prefix = `${savedCount}件を保存しました。`;
	if (codes.size !== 1) {
		return `${prefix}${failedCount}件は取得または保存できませんでした。Moodleのページを再読み込みして再試行し、解決しない場合は保存先を確認してください。`;
	}

	switch (failures[0]?.code) {
		case "DOWNLOAD_FAILED":
			return `${prefix}${failedCount}件をMoodleから取得できませんでした。Moodleのページを再読み込みしてから再試行してください。`;
		case "ALREADY_EXISTS":
			return `${prefix}${failedCount}件は保存先に同じ名前の資料があります。保存先を確認してください。`;
		case "INVALID_CONTENT":
			return `${prefix}${failedCount}件は資料の内容を安全に確認できませんでした。Moodleのページを再読み込みしてから再試行してください。`;
		case "IO_ERROR":
			return `${prefix}${failedCount}件をPCへ書き込めませんでした。保存先を開いて、空き容量やファイルの使用状況を確認してください。`;
	}
	return `${prefix}${failedCount}件は取得または保存できませんでした。再試行してください。`;
}

interface ManualDestination {
	path: string;
	relativePath: string;
	courseId: number | null;
}

/** 資料ごとに保存先候補を取得する。先頭資料だけで全件を代表させない。 */
export async function loadFileSuggestions(
	api: Pick<FuzzyApiClient, "suggestSavePath">,
	snapshot: MoodlePageSnapshot,
	pageUrl = typeof location === "undefined" ? "" : location.href,
): Promise<FileSuggestions> {
	const result = await loadFileSuggestionsWithFailures(api, snapshot, pageUrl);
	if (result.firstError) throw result.firstError;
	return result.suggestions;
}

/**
 * 一部の資料で候補生成に失敗しても、成功済みの正式な候補を利用者へ残す。
 * 失敗理由を推測した保存先は作らない。
 */
export async function loadFileSuggestionsWithFailures(
	api: Pick<FuzzyApiClient, "suggestSavePath">,
	snapshot: MoodlePageSnapshot,
	pageUrl = typeof location === "undefined" ? "" : location.href,
): Promise<FileSuggestionLoadResult> {
	const moodleCourseId = contextualMoodleCourseId(snapshot, pageUrl);
	const results = await Promise.all(
		snapshot.files.map(async (file) => {
			try {
				const suggestions = await api.suggestSavePath({
					course: {
						moodleCourseId,
						name: snapshot.courseName,
						academicYear: snapshot.academicYear,
						term: snapshot.term,
						sectionTitle: snapshot.sectionTitle,
						breadcrumbs: snapshot.breadcrumbs,
					},
					fileMeta: file,
				});
				return {
					id: fileId(file),
					suggestions: rankSuggestions(suggestions),
					error: null,
				};
			} catch (error) {
				return {
					id: fileId(file),
					suggestions: null,
					error,
				};
			}
		}),
	);
	const successfulEntries = results
		.filter(
			(
				result,
			): result is {
				id: string;
				suggestions: SaveSuggestion[];
				error: null;
			} => result.suggestions !== null,
		)
		.map(({ id, suggestions }) => [id, suggestions] as const);
	const failures = results.filter(
		(result): result is { id: string; suggestions: null; error: unknown } =>
			result.suggestions === null,
	);

	return {
		suggestions: new Map(successfulEntries),
		failedFileIds: failures.map(({ id }) => id),
		firstError: failures[0]?.error ?? null,
	};
}

/**
 * 保存パネルで利用者へ示す、候補取得後の状態を一つにまとめる。
 * APIが空配列を返した資料も「候補なし」に含め、失敗件数だけを残件として誤表示しない。
 */
export function saveSuggestionStatus(
	fileCount: number,
	suggestions: FileSuggestions,
	failedFileCount: number,
): SaveSuggestionStatus | null {
	if (fileCount === 0) {
		return {
			kind: "no-files",
			message:
				"このページでは保存できる資料が見つかりませんでした。資料が並んでいるコース画面を開くか、「資料一覧を再読み込み」を押してください。",
			reviewRules: false,
			suggestedFileCount: 0,
			unavailableFileCount: 0,
		};
	}

	const suggestedFileCount = [...suggestions.values()].filter((items) => items.length > 0).length;
	const unavailableFileCount = Math.max(0, fileCount - suggestedFileCount);
	if (failedFileCount >= fileCount) {
		return {
			kind: "all-failed",
			message:
				"保存先を提案できませんでした。Moodleから年度や学期などを確認できず、現在のフォルダーの作り方を当てはめられない可能性があります。「保存・整理設定」で見直すか、「資料一覧を再読み込み」を押してください。",
			reviewRules: true,
			suggestedFileCount: 0,
			unavailableFileCount,
		};
	}
	if (suggestedFileCount > 0 && unavailableFileCount > 0) {
		return {
			kind: "partial",
			message: `${suggestedFileCount}件の保存先を表示しています。残り${unavailableFileCount}件は提案できませんでした。表示できない資料の選択を外すと、候補がある資料だけ保存できます。「保存・整理設定」を見直すか、「資料一覧を再読み込み」を押してください。`,
			reviewRules: true,
			suggestedFileCount,
			unavailableFileCount,
		};
	}
	if (suggestedFileCount === 0) {
		return {
			kind: "no-candidates",
			message:
				"このページの資料に合う保存先を提案できませんでした。「保存・整理設定」でフォルダーの作り方を確認するか、「資料一覧を再読み込み」を押してください。",
			reviewRules: true,
			suggestedFileCount: 0,
			unavailableFileCount,
		};
	}
	return null;
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
		const key = `${destination.courseId ?? "none"}:${canonicalWindowsPath(path)}`;
		const existing = groups.get(key);
		if (existing) existing.files.push(file);
		else {
			groups.set(key, {
				key,
				path,
				relativePath: destination.relativePath,
				courseId: destination.courseId,
				files: [file],
			});
		}
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

/**
 * 全資料の提案が同じコース解決結果を参照している場合だけ編集対象として返す。
 * 複数コースが混ざるページで誤ったコースIDを更新しないための境界。
 */
export function courseFolderFromSuggestions(
	suggestions: FileSuggestions,
): CourseFolderNameResolution | null {
	const resolutions = [...suggestions.values()]
		.map((items) => items[0]?.courseFolder)
		.filter((item): item is CourseFolderNameResolution => Boolean(item));
	if (resolutions.length === 0 || resolutions.length !== suggestions.size) return null;

	const first = resolutions[0] as CourseFolderNameResolution;
	if (
		resolutions.some(
			(item) => item.courseId !== first.courseId || item.folderName !== first.folderName,
		)
	) {
		return null;
	}
	return first;
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
		courseId: suggestion?.courseFolder.courseId ?? null,
	};
}
