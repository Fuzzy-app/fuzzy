import { describe, expect, test } from "bun:test";
import { createApiClient } from "./index";
import { MockApiClient, courseFolderName, folderSegment } from "./mockClient";

describe("createApiClient フォールバック機構", () => {
	test("native-hostが存在しない環境ではmockモードにフォールバックする", async () => {
		const api = await createApiClient({ timeoutMs: 100, verbose: false });
		expect(api.mode).toBe("mock");
	});
});

describe("MockApiClient（サンプルデータ）", () => {
	const client = new MockApiClient();

	test("getDashboard: 6科目分のサマリが返る", async () => {
		const dashboard = await client.getDashboard();
		expect(dashboard.courses.length).toBe(6);
		expect(dashboard.totalFiles).toBe(9);
		expect(dashboard.totalViolations).toBe(2);
	});

	test("getDeadlines: needsReviewOnlyフィルタで異常検知の締切のみ返る", async () => {
		const result = await client.getDeadlines({ needsReviewOnly: true });
		expect(result.length).toBe(1);
		expect(result[0]?.title).toBe("認知科学概論 期末レポート");
	});

	test("search: サンプルデータから該当ページ込みで検索結果が返る", async () => {
		const result = await client.search("正規化");
		expect(result.length).toBe(2);
		expect(result[0]?.page).toBe(12);
	});

	test("suggestSavePath: Moodleのコース・ファイル情報から保存先候補を返す", async () => {
		const result = await client.suggestSavePath({
			course: {
				name: "データベース",
				sectionTitle: "第4回",
				breadcrumbs: ["マイコース", "データベース", "第4回"],
			},
			fileMeta: {
				title: "第4回_正規化.pdf",
				url: "https://moodle.example/pluginfile.php/1234/mod_resource/content/1/file.pdf",
				moodleFileId: "1234",
				sectionTitle: "第4回",
				mimeHint: "pdf",
			},
		});
		expect(result[0]?.path).toContain("データベース");
		expect(result[0]?.path).not.toContain("第4回");
		expect(result[1]?.path).toContain("第4回");

		const syllabusResult = await client.suggestSavePath({
			course: { name: "人工知能", sectionTitle: "授業計画", breadcrumbs: [] },
			fileMeta: {
				title: "授業計画.pdf",
				url: "https://moodle.example/mod/resource/view.php?id=10",
				moodleFileId: "10",
				sectionTitle: "授業計画",
				mimeHint: "pdf",
			},
		});
		expect(syllabusResult).toHaveLength(1);
		expect(syllabusResult[0]?.path).not.toContain("授業計画");

		const sanitizedResult = await client.suggestSavePath({
			course: { name: "情報科学📚（前期）", sectionTitle: "第4回🔬", breadcrumbs: [] },
			fileMeta: null,
		});
		expect(sanitizedResult[0]?.path).toContain("情報科学");
		expect(sanitizedResult[0]?.path).not.toMatch(/\p{Extended_Pictographic}/u);
		expect(sanitizedResult[1]?.path).toContain("第4回");
	});

	test("suggestSavePath: コース名の括弧内補足を保存先から除外する", () => {
		expect(courseFolderName("情報科学📚（2026年度・前期）")).toBe("情報科学");
		expect(courseFolderName("統計学 (担当: 山田)")).toBe("統計学");
		expect(folderSegment("第4回🔬（配布資料）")).toBe("第4回");
	});

	test("suggestSavePath: 同名になる場合も括弧内補足を候補名に表示しない", () => {
		const courseNames = ["英語（A）", "英語（B）"];
		expect(courseFolderName("英語（A）", courseNames)).toBe("英語");
		expect(courseFolderName("英語（B）", courseNames)).toBe("英語");
	});

	test("checkSimilarFiles: 保存前に似ている保存済みファイルを返す", async () => {
		const result = await client.checkSimilarFiles({
			fileMeta: {
				title: "第4回_正規化.pdf",
				url: "https://moodle.example/pluginfile.php/1234/mod_resource/content/1/file.pdf",
				moodleFileId: "1234",
				sectionTitle: "第4回",
				mimeHint: "pdf",
			},
		});
		expect(result.length).toBe(1);
		expect(result[0]?.similarity).toBeGreaterThan(0.8);
	});

	test("saveFiles: ユーザーが選んだファイルの保存結果を返す", async () => {
		const result = await client.saveFiles({
			targetPath: "C:\\Users\\sample\\Documents\\大学\\2026前期\\データベース\\第4回",
			files: [
				{
					title: "第4回_正規化.pdf",
					url: "https://moodle.example/pluginfile.php/1234/mod_resource/content/1/file.pdf",
					moodleFileId: "1234",
					sectionTitle: "第4回",
					mimeHint: "pdf",
				},
			],
		});
		expect(result.savedFileIds).toEqual(["1234"]);
	});

	test("extractZip: ZIPを展開し、簡略化後のパス一覧を返す", async () => {
		const result = await client.extractZip({
			fileMeta: {
				title: "正規化_メモ.zip",
				url: "https://moodle.example/pluginfile.php/1234/mod_resource/content/1/file.zip",
				moodleFileId: "1234",
				sectionTitle: "第4回",
				mimeHint: "zip",
			},
			targetPath: "C:\\Users\\sample\\Documents\\大学\\2026前期\\データベース\\第4回",
			destinationPath: "C:\\Users\\sample\\Documents\\大学\\2026前期\\データベース\\第4回\\展開",
			flatten: true,
		});
		expect(result.extractedPaths.length).toBe(2);
		expect(result.extractedPaths[0]).not.toContain("\\contents\\");
	});

	test("getRuleViolations: ルール違反ファイルが2件返る", async () => {
		const violations = await client.getRuleViolations();
		expect(violations.length).toBe(2);
	});

	test("getRules: アプリ演習のコース別例外ルールが含まれる", async () => {
		const rules = await client.getRules();
		expect(
			rules.courseOverrides.some(
				(o) => o.courseName === "アプリ演習" && o.splitBySection === false,
			),
		).toBe(true);
	});

	test("updateNotificationRules → getNotificationRules: 更新内容が反映される", async () => {
		const updated = [{ id: 1, offsetMinutes: 4320, label: "3日前", enabled: false }];
		await client.updateNotificationRules(updated);
		const result = await client.getNotificationRules();
		expect(result).toEqual(updated);
	});

	test("getLatestSyncEvent: 直近の同期結果（データ取得通知用）が返る", async () => {
		const event = await client.getLatestSyncEvent();
		expect(event?.changedAssignmentCount).toBe(2);
	});

	test("getAssignmentChanges: 直近の同期で検出された変更点が返る", async () => {
		const changes = await client.getAssignmentChanges();
		expect(changes.length).toBe(2);
		expect(changes.some((c) => c.field === "dueAtStatus" && c.newValue === "needs_review")).toBe(
			true,
		);
	});

	test("getAssignmentChanges: 最新の同期ID以降を指定すると差分なしになる", async () => {
		const latest = await client.getLatestSyncEvent();
		const changes = await client.getAssignmentChanges(latest?.id);
		expect(changes.length).toBe(0);
	});
});
