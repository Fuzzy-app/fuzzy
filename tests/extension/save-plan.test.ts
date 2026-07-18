import { describe, expect, test } from "bun:test";
import type { SaveSuggestion, SuggestSavePathRequest } from "@fuzzy/shared";
import {
	type FileSuggestions,
	buildSaveDestinationGroups,
	commonGroupSuggestions,
	createSelectedFilePaths,
	fileId,
	loadFileSuggestions,
	rankSuggestions,
} from "../../apps/extension/src/entrypoints/content/savePlan";
import type {
	MoodleFileLink,
	MoodlePageSnapshot,
} from "../../apps/extension/src/lib/moodle/pageSnapshot";

const ROOT = "C:\\Users\\sample\\Documents\\大学";

describe("資料別の保存計画", () => {
	test("全資料について個別に保存先候補を問い合わせる", async () => {
		const files = [createFile("資料1.pdf", "第1回", "1"), createFile("資料2.pdf", "第2回", "2")];
		const requestedIds: string[] = [];
		const api = {
			async suggestSavePath(request: SuggestSavePathRequest): Promise<SaveSuggestion[]> {
				requestedIds.push(request.fileMeta?.moodleFileId ?? "");
				return [createSuggestion(`2026前期\\データベース\\${request.fileMeta?.sectionTitle}`)];
			},
		};
		const suggestions = await loadFileSuggestions(api, createSnapshot(files));
		expect(requestedIds).toEqual(["1", "2"]);
		expect(suggestions.get(fileId(files[0] as MoodleFileLink))?.[0]?.relativePath).toContain(
			"第1回",
		);
		expect(suggestions.get(fileId(files[1] as MoodleFileLink))?.[0]?.relativePath).toContain(
			"第2回",
		);
	});

	test("異なる推奨先を保存先別に分け、手動指定時だけ一つへまとめる", () => {
		const files = [createFile("資料1.pdf", "第1回", "1"), createFile("資料2.pdf", "第2回", "2")];
		const suggestions: FileSuggestions = new Map([
			[fileId(files[0] as MoodleFileLink), [createSuggestion("2026前期\\データベース\\第1回")]],
			[fileId(files[1] as MoodleFileLink), [createSuggestion("2026前期\\データベース\\第2回")]],
		]);
		const selectedIds = new Set(files.map(fileId));
		const selectedPaths = createSelectedFilePaths(suggestions);

		const recommendedGroups = buildSaveDestinationGroups(
			files,
			selectedIds,
			suggestions,
			selectedPaths,
		);
		expect(recommendedGroups).toHaveLength(2);
		expect(recommendedGroups.map((group) => group.files.length)).toEqual([1, 1]);

		const manualRelativePath = "2026前期\\データベース\\まとめ";
		const manualGroups = buildSaveDestinationGroups(
			files,
			selectedIds,
			suggestions,
			selectedPaths,
			{ path: `${ROOT}\\${manualRelativePath}`, relativePath: manualRelativePath },
		);
		expect(manualGroups).toHaveLength(1);
		expect(manualGroups[0]?.files).toHaveLength(2);
	});

	test("同じ保存先の資料に共通する代替候補だけを返す", () => {
		const files = [createFile("資料1.pdf", "第1回", "1"), createFile("資料2.pdf", "第1回", "2")];
		const primary = createSuggestion("2026前期\\データベース\\第1回", 0.92);
		const commonAlternative = createSuggestion("2026前期\\データベース", 0.6);
		const suggestions: FileSuggestions = new Map([
			[fileId(files[0] as MoodleFileLink), [primary, commonAlternative]],
			[
				fileId(files[1] as MoodleFileLink),
				[primary, commonAlternative, createSuggestion("一時保存", 0.2)],
			],
		]);
		const groups = buildSaveDestinationGroups(
			files,
			new Set(files.map(fileId)),
			suggestions,
			createSelectedFilePaths(suggestions),
		);
		expect(groups).toHaveLength(1);
		const group = groups[0];
		if (!group) throw new Error("保存先グループが生成されていません");
		expect(commonGroupSuggestions(group, suggestions).map((item) => item.relativePath)).toEqual([
			primary.relativePath,
			commonAlternative.relativePath,
		]);
	});

	test("絶対パスと相対パスが一致しない候補や相対移動を含む候補を破棄する", () => {
		expect(
			rankSuggestions([
				createSuggestion("2026前期\\データベース"),
				{
					path: `${ROOT}\\2026前期\\データベース`,
					relativePath: "..\\別の場所",
					confidence: 1,
				},
				{
					path: `${ROOT}\\2026前期\\データベース`,
					relativePath: "2026前期\\離散数学",
					confidence: 1,
				},
			]),
		).toEqual([createSuggestion("2026前期\\データベース")]);
	});
});

function createSuggestion(relativePath: string, confidence = 0.9): SaveSuggestion {
	return { path: `${ROOT}\\${relativePath}`, relativePath, confidence };
}

function createFile(title: string, sectionTitle: string, id: string): MoodleFileLink {
	return {
		title,
		url: `https://moodle.example/pluginfile.php/${id}/mod_resource/content/1/${title}`,
		moodleFileId: id,
		sectionTitle,
		mimeHint: "pdf",
	};
}

function createSnapshot(files: MoodleFileLink[]): MoodlePageSnapshot {
	return {
		courseName: "データベース",
		sectionTitle: null,
		breadcrumbs: ["2026前期", "データベース"],
		files,
		pageText: "",
		dashboardText: "",
		assignmentHints: [],
		collectedAt: "2026-07-18T00:00:00.000Z",
	};
}
