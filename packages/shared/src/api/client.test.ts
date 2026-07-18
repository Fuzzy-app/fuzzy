import { describe, expect, test } from "bun:test";
import type { NotificationRule, NotificationRuleInput } from "../types";
import { createApiClient } from "./index";
import { MockApiClient } from "./mockClient";

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
		expect(result[0]?.relativePath).toBe("2026前期\\データベース\\第4回");
		expect(result[0]?.path).toBe(
			"C:\\Users\\sample\\Documents\\大学\\2026前期\\データベース\\第4回",
		);
		expect(result[1]?.relativePath).toBe("2026前期\\データベース");

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
		expect(syllabusResult[0]?.relativePath).not.toContain("授業計画");
	});

	test("suggestSavePath: コース名の補足・角括弧・絵文字を保存先から除外する", async () => {
		const result = await client.suggestSavePath({
			course: {
				name: "情報科学📚［2026年度・前期］",
				sectionTitle: "第4回🔬[配布資料]",
				breadcrumbs: ["2026前期"],
			},
			fileMeta: {
				title: "講義資料.pdf",
				url: "https://moodle.example/pluginfile.php/40/file.pdf",
				moodleFileId: "40",
				sectionTitle: "第4回🔬[配布資料]",
				mimeHint: "pdf",
			},
		});
		expect(result[0]?.relativePath).toBe("2026前期\\情報科学\\第4回");
		expect(result[0]?.relativePath).not.toMatch(/[()[\]（）［］\p{Extended_Pictographic}]/u);
	});

	test("suggestSavePath: 更新済みルールとコース別例外をその場で反映する", async () => {
		const freshClient = new MockApiClient();
		await freshClient.updateCourseRuleOverride({
			courseId: 2,
			override: {
				splitBySection: false,
				patternTemplate: "{term}/{course}",
				note: null,
			},
		});
		const result = await freshClient.suggestSavePath({
			course: { name: "データベース", sectionTitle: "Week 4", breadcrumbs: [] },
			fileMeta: {
				title: "normalization.pdf",
				url: "https://moodle.example/mod/resource/view.php?id=10",
				moodleFileId: "10",
				sectionTitle: "Week 4",
				mimeHint: "pdf",
			},
		});
		expect(result).toHaveLength(1);
		expect(result[0]?.relativePath).toBe("2026前期\\データベース");
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
		const input: NotificationRuleInput[] = [{ id: 1, offsetMinutes: 4320, enabled: false }];
		const updated: NotificationRule[] = [
			{ id: 1, offsetMinutes: 4320, label: "3日前", enabled: false },
		];
		const updateResult = await client.updateNotificationRules(input);
		const result = await client.getNotificationRules();
		expect(updateResult).toEqual({ ok: true, rules: updated });
		expect(result).toEqual(updated);
	});

	test("updateNotificationRules: 任意ルールのIDを保存側で採番する", async () => {
		const updateResult = await client.updateNotificationRules([
			{ offsetMinutes: 30, enabled: true },
		]);
		expect(updateResult.rules).toEqual([
			{ id: 5, offsetMinutes: 30, label: "30分前", enabled: true },
		]);
	});

	test("updateNotificationRules: 範囲外と重複した通知タイミングを拒否する", async () => {
		await expect(
			client.updateNotificationRules([{ offsetMinutes: 525601, enabled: true }]),
		).rejects.toMatchObject({ code: "RULE_CONFLICT" });
		await expect(
			client.updateNotificationRules([
				{ offsetMinutes: 60, enabled: true },
				{ offsetMinutes: 60, enabled: false },
			]),
		).rejects.toMatchObject({ code: "RULE_CONFLICT" });
	});

	test("通知設定はモッククライアントを作り直すとサンプルへ戻る", async () => {
		const freshClient = new MockApiClient();
		const result = await freshClient.getNotificationRules();
		expect(result.find((rule) => rule.id === 1)?.enabled).toBe(true);
		expect(result.find((rule) => rule.id === 3)).toMatchObject({
			offsetMinutes: 540,
			label: "9時間前",
		});
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
