import { describe, expect, test } from "bun:test";
import {
	LocalRuleManagementApi,
	MemoryRuleManagementStorage,
	RULE_MANAGEMENT_STORAGE_KEY,
} from "../../apps/extension/src/lib/rules/api";
import {
	BackgroundRuleManagementApi,
	respondToRuleManagementRequest,
} from "../../apps/extension/src/lib/rules/backgroundApi";
import { RuleManagementStore } from "../../apps/extension/src/lib/rules/state";

describe("LocalRuleManagementApi", () => {
	test("共有 getRules サンプルで初期化し、アプリ演習の例外を返す", async () => {
		const api = new LocalRuleManagementApi({
			storage: new MemoryRuleManagementStorage(),
		});

		const rules = await api.getRules();

		expect(rules.globalPatternTemplate).toBe("{year}/{term}/{course}/第{section}回");
		expect(rules.courseOverrides).toContainEqual({
			courseId: 4,
			courseName: "アプリ演習",
			splitBySection: false,
			patternTemplate: "{year}/{term}/{course}",
			note: "実習課題はまとめて1フォルダで管理したいため回ごとに分けない",
		});
	});

	test("グローバルルールをクライアントの再生成後も保持する", async () => {
		const storage = new MemoryRuleManagementStorage();
		const firstApi = new LocalRuleManagementApi({ storage });

		await firstApi.updateGlobalRule({ patternTemplate: "{year}/{course}/{assignment}" });
		const secondApi = new LocalRuleManagementApi({ storage });

		expect((await secondApi.getRules()).globalPatternTemplate).toBe("{year}/{course}/{assignment}");
	});

	test("コース別例外を追加し、同じ courseId の更新で置き換える", async () => {
		const storage = new MemoryRuleManagementStorage();
		const api = new LocalRuleManagementApi({ storage });

		await api.updateCourseRuleOverride({
			courseId: 8,
			override: {
				courseName: "情報アーキテクチャ",
				splitBySection: true,
				patternTemplate: "{year}/{course}/第{section}回",
				note: "講義回で整理",
			},
		});
		await api.updateCourseRuleOverride({
			courseId: 8,
			override: {
				courseName: "情報アーキテクチャ",
				splitBySection: false,
				patternTemplate: "{year}/{course}",
				note: "科目単位に変更",
			},
		});

		const matches = (await api.getRules()).courseOverrides.filter(
			(override) => override.courseId === 8,
		);
		expect(matches).toEqual([
			{
				courseId: 8,
				courseName: "情報アーキテクチャ",
				splitBySection: false,
				patternTemplate: "{year}/{course}",
				note: "科目単位に変更",
			},
		]);
	});

	test("壊れた保存値は検証して共有サンプルへ戻す", async () => {
		const storage = new MemoryRuleManagementStorage();
		await storage.set(RULE_MANAGEMENT_STORAGE_KEY, {
			version: 1,
			revision: 3,
			updatedAt: null,
			rules: { globalPatternTemplate: "", courseOverrides: "invalid" },
		});

		const rules = await new LocalRuleManagementApi({ storage }).getRules();

		expect(rules.globalPatternTemplate).toBe("{year}/{term}/{course}/第{section}回");
	});

	test("UIを介さない更新でもルールの意味が矛盾する値を拒否する", async () => {
		const api = new LocalRuleManagementApi({ storage: new MemoryRuleManagementStorage() });

		await expect(api.updateGlobalRule({ patternTemplate: "{year}/{assignment}" })).rejects.toThrow(
			"{course}",
		);
		await expect(
			api.updateCourseRuleOverride({
				courseId: 8,
				override: {
					courseName: "情報アーキテクチャ",
					splitBySection: false,
					patternTemplate: "{year}/{course}/第{section}回",
					note: null,
				},
			}),
		).rejects.toThrow("{section}");
		await expect(
			api.updateCourseRuleOverride({
				courseId: 8,
				override: {
					courseName: "情報アーキテクチャ",
					splitBySection: true,
					patternTemplate: "{year}/{course}",
					note: null,
				},
			}),
		).rejects.toThrow("{section}");
	});

	test("グローバル変更で継承中のコース例外が矛盾する場合は拒否する", async () => {
		const api = new LocalRuleManagementApi({ storage: new MemoryRuleManagementStorage() });
		await api.updateGlobalRule({ patternTemplate: "{year}/{course}/{assignment}" });
		await api.updateCourseRuleOverride({
			courseId: 8,
			override: {
				courseName: "情報アーキテクチャ",
				splitBySection: false,
				patternTemplate: null,
				note: null,
			},
		});

		await expect(
			api.updateGlobalRule({ patternTemplate: "{year}/{course}/第{section}回" }),
		).rejects.toThrow("{section}");
		expect((await api.getRules()).globalPatternTemplate).toBe("{year}/{course}/{assignment}");
	});

	test("回ごとに分ける継承例外を壊すグローバル変更は拒否する", async () => {
		const api = new LocalRuleManagementApi({ storage: new MemoryRuleManagementStorage() });
		await api.updateCourseRuleOverride({
			courseId: 8,
			override: {
				courseName: "情報アーキテクチャ",
				splitBySection: true,
				patternTemplate: null,
				note: null,
			},
		});

		await expect(
			api.updateGlobalRule({ patternTemplate: "{year}/{course}/{assignment}" }),
		).rejects.toThrow("{section}");
		expect((await api.getRules()).globalPatternTemplate).toBe(
			"{year}/{term}/{course}/第{section}回",
		);
	});
});

describe("RuleManagementStore", () => {
	test("保存後のルールと保存対象を単一スナップショットへ反映する", async () => {
		const api = new LocalRuleManagementApi({ storage: new MemoryRuleManagementStorage() });
		const store = new RuleManagementStore(api);

		await store.load();
		await store.updateGlobalRule({ patternTemplate: "{course}/{assignment}" });

		expect(store.snapshot.status).toBe("ready");
		expect(store.snapshot.rules?.globalPatternTemplate).toBe("{course}/{assignment}");
		expect(store.snapshot.saving).toBeNull();
		expect(store.snapshot.lastSavedTarget).toEqual({ scope: "global" });
		expect(store.snapshot.lastSavedAt).not.toBeNull();
	});
});

describe("BackgroundRuleManagementApi", () => {
	test("複数タブ相当のクライアントから同時更新しても別スコープの変更を失わない", async () => {
		const centralApi = new LocalRuleManagementApi({
			storage: new MemoryRuleManagementStorage(),
		});
		const transport = {
			sendMessage: (message: Parameters<typeof respondToRuleManagementRequest>[1]) =>
				respondToRuleManagementRequest(centralApi, message),
		};
		const firstTab = new BackgroundRuleManagementApi(transport);
		const secondTab = new BackgroundRuleManagementApi(transport);

		await Promise.all([
			firstTab.updateGlobalRule({ patternTemplate: "{year}/{course}/{assignment}" }),
			secondTab.updateCourseRuleOverride({
				courseId: 8,
				override: {
					courseName: "情報アーキテクチャ",
					splitBySection: false,
					patternTemplate: "{year}/{course}",
					note: null,
				},
			}),
		]);

		const rules = await firstTab.getRules();
		expect(rules.globalPatternTemplate).toBe("{year}/{course}/{assignment}");
		expect(rules.courseOverrides).toContainEqual({
			courseId: 8,
			courseName: "情報アーキテクチャ",
			splitBySection: false,
			patternTemplate: "{year}/{course}",
			note: null,
		});
	});
});
