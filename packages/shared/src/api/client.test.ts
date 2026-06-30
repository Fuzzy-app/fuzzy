import {describe, expect, test} from "bun:test";
import {createApiClient} from "./index";
import {MockApiClient} from "./mockClient";

describe("createApiClient フォールバック機構", () => {
	test("native-hostが存在しない環境ではmockモードにフォールバックする", async () => {
		const api = await createApiClient({timeoutMs: 100, verbose: false});
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
		const result = await client.getDeadlines({needsReviewOnly: true});
		expect(result.length).toBe(1);
		expect(result[0]?.title).toBe("認知科学概論 期末レポート");
	});

	test("search: サンプルデータから該当ページ込みで検索結果が返る", async () => {
		const result = await client.search("正規化");
		expect(result.length).toBe(2);
		expect(result[0]?.page).toBe(12);
	});

	test("getRuleViolations: ルール違反ファイルが2件返る", async () => {
		const violations = await client.getRuleViolations();
		expect(violations.length).toBe(2);
	});

	test("getRules: アプリ演習のコース別例外ルールが含まれる", async () => {
		const rules = await client.getRules();
		expect(rules.courseOverrides.some((o) => o.courseName === "アプリ演習" && o.splitBySection === false)).toBe(
			true,
		);
	});

	test("updateNotificationRules → getNotificationRules: 更新内容が反映される", async () => {
		const updated = [{id: 1, offsetMinutes: 4320, label: "3日前", enabled: false}];
		await client.updateNotificationRules(updated);
		const result = await client.getNotificationRules();
		expect(result).toEqual(updated);
	});
});
