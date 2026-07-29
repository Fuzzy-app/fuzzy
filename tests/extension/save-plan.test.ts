import { describe, expect, test } from "bun:test";
import type { SaveSuggestion, SuggestSavePathRequest } from "@fuzzy/shared";
import {
	type FileSuggestions,
	buildSaveDestinationGroups,
	commonGroupSuggestions,
	courseFolderFromSuggestions,
	createSelectedFilePaths,
	fileId,
	loadFileSuggestions,
	loadFileSuggestionsWithFailures,
	rankSuggestions,
	saveSuggestionStatus,
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
		const requestedCourses: SuggestSavePathRequest["course"][] = [];
		const api = {
			async suggestSavePath(request: SuggestSavePathRequest): Promise<SaveSuggestion[]> {
				requestedIds.push(request.fileMeta?.moodleFileId ?? "");
				requestedCourses.push(request.course);
				return [createSuggestion(`2026前期\\データベース\\${request.fileMeta?.sectionTitle}`)];
			},
		};
		const suggestions = await loadFileSuggestions(api, createSnapshot(files));
		expect(requestedIds).toEqual(["1", "2"]);
		expect(requestedCourses[0]).toEqual({
			moodleCourseId: "course-412",
			name: "データベース",
			academicYear: 2026,
			term: "2026前期",
			sectionTitle: null,
			breadcrumbs: ["2026前期", "データベース"],
		});
		expect(suggestions.get(fileId(files[0] as MoodleFileLink))?.[0]?.relativePath).toContain(
			"第1回",
		);
		expect(suggestions.get(fileId(files[1] as MoodleFileLink))?.[0]?.relativePath).toContain(
			"第2回",
		);
	});

	test("一部の候補生成が失敗しても成功した資料の保存先を残す", async () => {
		const files = [createFile("資料1.pdf", "第1回", "1"), createFile("資料2.pdf", "第2回", "2")];
		const result = await loadFileSuggestionsWithFailures(
			{
				async suggestSavePath(request: SuggestSavePathRequest): Promise<SaveSuggestion[]> {
					if (request.fileMeta?.moodleFileId === "2") {
						throw new Error("入力内容が不正です");
					}
					return [createSuggestion("データベース\\第1回")];
				},
			},
			createSnapshot(files),
		);

		expect(result.suggestions.get(fileId(files[0] as MoodleFileLink))).toHaveLength(1);
		expect(result.suggestions.has(fileId(files[1] as MoodleFileLink))).toBe(false);
		expect(result.failedFileIds).toEqual([fileId(files[1] as MoodleFileLink)]);
		expect(result.firstError).toBeInstanceOf(Error);
	});

	test("全候補の生成に失敗した場合も資料ごとの失敗を保持する", async () => {
		const files = [createFile("資料1.pdf", "第1回", "1"), createFile("資料2.pdf", "第2回", "2")];
		const result = await loadFileSuggestionsWithFailures(
			{
				async suggestSavePath(): Promise<SaveSuggestion[]> {
					throw new Error("入力内容が不正です");
				},
			},
			createSnapshot(files),
		);

		expect(result.suggestions.size).toBe(0);
		expect(result.failedFileIds).toEqual(files.map(fileId));
		expect(
			saveSuggestionStatus(files.length, result.suggestions, result.failedFileIds.length)?.kind,
		).toBe("all-failed");
	});

	test("資料未検出・全失敗・一部失敗・候補なしを区別して次の操作を案内する", () => {
		const noFiles = saveSuggestionStatus(0, new Map(), 0);
		expect(noFiles).toMatchObject({
			kind: "no-files",
			reviewRules: false,
			suggestedFileCount: 0,
			unavailableFileCount: 0,
		});
		expect(noFiles?.message).toContain("コース画面");
		expect(noFiles?.message).toContain("資料一覧を再読み込み");

		const allFailed = saveSuggestionStatus(2, new Map(), 2);
		expect(allFailed).toMatchObject({
			kind: "all-failed",
			reviewRules: true,
			suggestedFileCount: 0,
			unavailableFileCount: 2,
		});
		expect(allFailed?.message).toContain("保存・整理設定");
		expect(allFailed?.message).toContain("年度や学期");

		const oneSuggestion = new Map([
			["file-1", [createSuggestion("データベース\\第1回")]],
			["file-2", []],
		]);
		const partial = saveSuggestionStatus(3, oneSuggestion, 1);
		expect(partial).toMatchObject({
			kind: "partial",
			reviewRules: true,
			suggestedFileCount: 1,
			unavailableFileCount: 2,
		});
		expect(partial?.message).toContain("残り2件");
		expect(partial?.message).toContain("選択を外す");

		const noCandidates = saveSuggestionStatus(
			2,
			new Map([
				["file-1", []],
				["file-2", []],
			]),
			0,
		);
		expect(noCandidates).toMatchObject({
			kind: "no-candidates",
			reviewRules: true,
			suggestedFileCount: 0,
			unavailableFileCount: 2,
		});
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
			{
				path: `${ROOT}\\${manualRelativePath}`,
				relativePath: manualRelativePath,
				courseId: 2,
			},
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
					courseFolder: courseFolder(),
				},
				{
					path: `${ROOT}\\2026前期\\データベース`,
					relativePath: "2026前期\\離散数学",
					confidence: 1,
					courseFolder: courseFolder(),
				},
			]),
		).toEqual([createSuggestion("2026前期\\データベース")]);
	});

	test("全資料が同じコース解決結果を持つ場合だけ編集対象を返す", () => {
		const first = createSuggestion("2026前期\\データベース\\第1回");
		const second = createSuggestion("2026前期\\データベース\\第2回");
		expect(
			courseFolderFromSuggestions(
				new Map([
					["1", [first]],
					["2", [second]],
				]),
			),
		).toEqual(courseFolder());

		second.courseFolder = { courseId: 3, folderName: "離散数学", warnings: [] };
		expect(
			courseFolderFromSuggestions(
				new Map([
					["1", [first]],
					["2", [second]],
				]),
			),
		).toBeNull();

		expect(
			courseFolderFromSuggestions(
				new Map([
					["1", [first]],
					["2", []],
				]),
			),
		).toBeNull();
	});
});

function createSuggestion(relativePath: string, confidence = 0.9): SaveSuggestion {
	return {
		path: `${ROOT}\\${relativePath}`,
		relativePath,
		confidence,
		courseFolder: courseFolder(),
	};
}

function courseFolder(): SaveSuggestion["courseFolder"] {
	return { courseId: 2, folderName: "データベース", warnings: [] };
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
		moodleCourseId: "course-412",
		courseName: "データベース",
		academicYear: 2026,
		term: "2026前期",
		sectionTitle: null,
		breadcrumbs: ["2026前期", "データベース"],
		files,
		pageText: "",
		dashboardText: "",
		assignmentHints: [],
		collectedAt: "2026-07-18T00:00:00.000Z",
	};
}
