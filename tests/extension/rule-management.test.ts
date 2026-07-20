import { describe, expect, test } from "bun:test";
import {
	MockApiClient,
	RULE_PRESETS,
	createRulePreviewValues,
	previewRulePattern,
	validateRulePattern,
} from "@fuzzy/shared";
import { parseHTML } from "linkedom";
import { createRuleManagementScreen } from "../../apps/extension/src/entrypoints/content/rulesScreen";
import {
	BackgroundRuleManagementApi,
	FUZZY_RULE_MANAGEMENT_MESSAGE_TYPE,
	isRuleManagementRequestMessage,
	respondToRuleManagementRequest,
} from "../../apps/extension/src/lib/rules/backgroundApi";
import { RuleManagementStore } from "../../apps/extension/src/lib/rules/state";
import type { RuleManagementApi } from "../../apps/extension/src/lib/rules/types";

describe("MockApiClient のルール管理", () => {
	test("共有サンプルで初期化し、アプリ演習の例外を返す", async () => {
		const rules = await new MockApiClient().getRules();

		expect(rules.globalPatternTemplate).toBe("{term}/{course}/第{section}回");
		expect(rules.courseOverrides).toContainEqual({
			courseId: 4,
			courseName: "アプリ演習",
			splitBySection: false,
			patternTemplate: "{term}/{course}",
			note: "実習課題はまとめて1フォルダで管理したいため回ごとに分けない",
		});
	});

	test("更新は同じモッククライアント内だけで保持し、新しいクライアントへ永続化しない", async () => {
		const firstApi = new MockApiClient();
		await firstApi.updateGlobalRule({ patternTemplate: "{year}/{course}/{assignment}" });

		expect((await firstApi.getRules()).globalPatternTemplate).toBe("{year}/{course}/{assignment}");
		expect((await new MockApiClient().getRules()).globalPatternTemplate).toBe(
			"{term}/{course}/第{section}回",
		);
	});

	test("コース名は courseId から解決し、同じ courseId の更新で置き換える", async () => {
		const api = new MockApiClient();
		await api.updateCourseRuleOverride({
			courseId: 1,
			override: {
				splitBySection: true,
				patternTemplate: "{year}/{course}/第{section}回",
				note: "講義回で整理",
			},
		});
		await api.updateCourseRuleOverride({
			courseId: 1,
			override: {
				splitBySection: false,
				patternTemplate: "{year}/{course}",
				note: "科目単位に変更",
			},
		});

		expect((await api.getRules()).courseOverrides).toContainEqual({
			courseId: 1,
			courseName: "情報アーキテクチャ",
			splitBySection: false,
			patternTemplate: "{year}/{course}",
			note: "科目単位に変更",
		});
	});

	test("未知のコースIDを拒否する", async () => {
		const api = new MockApiClient();
		await expect(
			api.updateCourseRuleOverride({
				courseId: 999,
				override: {
					splitBySection: false,
					patternTemplate: "{course}",
					note: null,
				},
			}),
		).rejects.toThrow("見つかりません");
	});

	test("継承中のコース例外を壊すグローバル変更を拒否する", async () => {
		const api = new MockApiClient();
		await api.updateCourseRuleOverride({
			courseId: 1,
			override: {
				splitBySection: true,
				patternTemplate: null,
				note: null,
			},
		});

		await expect(
			api.updateGlobalRule({ patternTemplate: "{year}/{course}/{assignment}" }),
		).rejects.toThrow("情報アーキテクチャ");
	});

	test("複数クライアント相当の同時更新でも別スコープの変更を失わない", async () => {
		const centralApi = new MockApiClient();
		const transport = {
			sendMessage: (message: Parameters<typeof respondToRuleManagementRequest>[1]) =>
				respondToRuleManagementRequest(Promise.resolve(centralApi), message),
		};
		const firstTab = new BackgroundRuleManagementApi(transport);
		const secondTab = new BackgroundRuleManagementApi(transport);

		await Promise.all([
			firstTab.updateGlobalRule({ patternTemplate: "{year}/{course}/{assignment}" }),
			secondTab.updateCourseRuleOverride({
				courseId: 1,
				override: {
					splitBySection: false,
					patternTemplate: "{year}/{course}",
					note: null,
				},
			}),
		]);

		const rules = await firstTab.getRules();
		expect(rules.globalPatternTemplate).toBe("{year}/{course}/{assignment}");
		expect(rules.courseOverrides).toContainEqual({
			courseId: 1,
			courseName: "情報アーキテクチャ",
			splitBySection: false,
			patternTemplate: "{year}/{course}",
			note: null,
		});
	});

	test("警告・重複一覧もルール専用のbackground境界で中継する", async () => {
		const centralApi = new MockApiClient();
		const transport = {
			sendMessage: (message: Parameters<typeof respondToRuleManagementRequest>[1]) =>
				respondToRuleManagementRequest(Promise.resolve(centralApi), message),
		};
		const client = new BackgroundRuleManagementApi(transport);

		expect((await client.getRuleViolations())[0]).toMatchObject({
			courseId: 2,
			relativePath: "正規化_メモ.docx",
		});
		expect((await client.getDuplicateGroups())[0]?.members[0]).toHaveProperty("relativePath");
		expect(
			isRuleManagementRequestMessage({
				type: FUZZY_RULE_MANAGEMENT_MESSAGE_TYPE,
				method: "getDuplicateGroups",
				request: {},
			}),
		).toBe(true);
	});
});

describe("ルールテンプレート", () => {
	test.each([
		["{course}/../Windows", "相対移動"],
		["{course}/{unknown}", "未対応"],
		["C:\\Users\\{course}", "絶対パス"],
		["{course}/CON", "予約名"],
	])("危険または未対応のテンプレート %s を拒否する", (pattern, expectedMessage) => {
		expect(validateRulePattern(pattern)).toContain(expectedMessage);
	});

	test("年度と学期のプレビューを現在の学年から生成する", () => {
		const values = createRulePreviewValues(new Date("2027-01-15T00:00:00+09:00"));

		expect(values.year).toBe("2026");
		expect(values.term).toBe("2026後期");
		expect(previewRulePattern("{term}/{course}/{assignment}", values)).toBe(
			"2026後期/アプリ演習/第05回制作課題",
		);
	});

	test("初期セットアップと管理画面が同じプリセット定義を利用する", () => {
		expect(RULE_PRESETS.map((preset) => preset.id)).toEqual([
			"year-course-assignment",
			"semester-course-assignment",
			"course-assignment",
		]);
	});
});

describe("RuleManagementStore", () => {
	test("保存後のルールと保存対象を単一スナップショットへ反映する", async () => {
		const store = new RuleManagementStore(new MockApiClient());

		await store.load();
		await store.updateGlobalRule({ patternTemplate: "{course}/{assignment}" });

		expect(store.snapshot.status).toBe("ready");
		expect(store.snapshot.rules?.globalPatternTemplate).toBe("{course}/{assignment}");
		expect(store.snapshot.saving).toBeNull();
		expect(store.snapshot.lastSavedTarget).toEqual({ scope: "global" });
		expect(store.snapshot.lastSavedAt).not.toBeNull();
		expect(store.snapshot.mutationRevision).toBe(1);
	});

	test("更新後の再読込に失敗しても、更新成功revisionを失わない", async () => {
		const mock = new MockApiClient();
		let failReload = false;
		const api: RuleManagementApi = {
			mode: "mock",
			getRules: () => (failReload ? Promise.reject(new Error("再読込に失敗")) : mock.getRules()),
			updateGlobalRule: async (request) => {
				const result = await mock.updateGlobalRule(request);
				failReload = true;
				return result;
			},
			updateCourseRuleOverride: (request) => mock.updateCourseRuleOverride(request),
			getRuleViolations: () => mock.getRuleViolations(),
			getDuplicateGroups: () => mock.getDuplicateGroups(),
		};
		const store = new RuleManagementStore(api);
		await store.load();

		await expect(
			store.updateGlobalRule({ patternTemplate: "{course}/{assignment}" }),
		).rejects.toThrow("再読込に失敗");
		expect(store.snapshot.mutationRevision).toBe(1);
		expect(store.snapshot.rules?.globalPatternTemplate).toBe("{term}/{course}/第{section}回");
	});
});

describe("ルール管理画面", () => {
	test("ルールを読み込み、危険な入力では保存ボタンを無効化する", async () => {
		const { document, window } = parseHTML("<html><head></head><body></body></html>");
		Object.assign(globalThis, {
			document,
			window,
			HTMLElement: window.HTMLElement,
		});
		const api = new MockApiClient();
		const screen = createRuleManagementScreen({
			store: new RuleManagementStore(api),
			loadCourses: async () => (await api.getDashboard()).courses,
		});
		document.body.append(screen.root);
		await screen.activate();

		expect(screen.root.querySelector("h1")?.textContent).toBe("保存ルールを管理");
		expect(screen.root.querySelector(".fuzzy-rules-message.is-mock")?.textContent).toContain(
			"再起動後にリセット",
		);
		expect(screen.root.querySelectorAll(".fuzzy-rules-preset")).toHaveLength(RULE_PRESETS.length);

		const input = screen.root.querySelector<HTMLInputElement>(
			'input[aria-label="グローバルルールのテンプレート"]',
		);
		if (!input) throw new Error("グローバルルール入力欄がありません。");
		input.value = "{course}/../Windows";
		input.dispatchEvent(new window.Event("input"));

		expect(screen.root.querySelector(".fuzzy-rules-validation")?.textContent).toContain("相対移動");
		expect(screen.root.querySelector<HTMLButtonElement>(".fuzzy-rules-save-button")?.disabled).toBe(
			true,
		);

		const warningTab = screen.root.querySelector<HTMLButtonElement>("#fuzzy-rule-integrity-tab");
		expect(warningTab?.disabled).toBe(false);
		expect(warningTab?.getAttribute("role")).toBe("tab");
		warningTab?.click();
		await screen.activate();
		expect(warningTab?.getAttribute("aria-controls")).toBe("fuzzy-rule-integrity-panel");
		const currentWarningTab = screen.root.querySelector<HTMLButtonElement>(
			"#fuzzy-rule-integrity-tab",
		);
		expect(currentWarningTab?.getAttribute("aria-selected")).toBe("true");
		expect(
			screen.root.querySelector("#fuzzy-rule-integrity-panel")?.getAttribute("aria-labelledby"),
		).toBe("fuzzy-rule-integrity-tab");
		expect(screen.root.querySelector("#fuzzy-rule-integrity-panel")?.textContent).toContain(
			"正規化_メモ.docx",
		);

		const homeKey = new window.Event("keydown", { bubbles: true });
		Object.defineProperty(homeKey, "key", { value: "Home" });
		currentWarningTab?.dispatchEvent(homeKey);
		expect(
			screen.root.querySelector("#fuzzy-rule-settings-tab")?.getAttribute("aria-selected"),
		).toBe("true");
	});
});
