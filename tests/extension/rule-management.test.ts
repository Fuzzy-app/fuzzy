import { describe, expect, test } from "bun:test";
import {
	MockApiClient,
	RULE_PRESETS,
	createRulePreviewValues,
	createRuleSegment,
	createRuleSegmentsFromTemplate,
	previewRulePattern,
	previewRuleSegments,
	ruleSegmentsToTemplate,
	validateCourseRuleOverride,
	validateRulePattern,
	validateRuleSegments,
} from "@fuzzy/shared";
import { parseHTML } from "linkedom";
import { buildCourseRulePanel } from "../../apps/extension/src/entrypoints/content/courseRulePanel";
import { createRuleManagementScreen } from "../../apps/extension/src/entrypoints/content/rulesScreen";
import { createStructuredRuleBuilder } from "../../apps/extension/src/entrypoints/content/structuredRuleBuilder";
import {
	BackgroundRuleManagementApi,
	FUZZY_RULE_MANAGEMENT_MESSAGE_TYPE,
	isRuleManagementRequestMessage,
	respondToRuleManagementRequest,
} from "../../apps/extension/src/lib/rules/backgroundApi";
import {
	RuleManagementStore,
	createRuleManagementStore,
} from "../../apps/extension/src/lib/rules/state";
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

	test("構造化モデルを保存形式へ変換し、内部表現を出さずにプレビューする", () => {
		const segments = [
			createRuleSegment("year", 0),
			createRuleSegment("term", 1),
			createRuleSegment("course", 2),
			createRuleSegment("fixed", 3, "配布資料"),
		];
		expect(validateRuleSegments(segments)).toBeNull();
		expect(ruleSegmentsToTemplate(segments)).toBe("{year}/{term}/{course}/配布資料");
		expect(
			previewRuleSegments(segments, createRulePreviewValues(new Date("2026-05-01T00:00:00+09:00"))),
		).toBe("2026 / 2026前期 / アプリ演習 / 配布資料");
		expect(createRuleSegmentsFromTemplate("{term}/{course}/第{section}回")).toMatchObject([
			{ kind: "term" },
			{ kind: "course" },
			{ kind: "section" },
		]);
	});

	test("削除後に同じ位置へ同種の項目を追加しても行IDが重複しない", () => {
		const retained = createRuleSegment("fixed", 2, "配布資料");
		const addedAfterDeletion = createRuleSegment("fixed", 2, "参考資料");

		expect(addedAfterDeletion.id).not.toBe(retained.id);
		expect(new Set([retained.id, addedAfterDeletion.id]).size).toBe(2);
		expect(ruleSegmentsToTemplate([retained, addedAfterDeletion])).toBe("配布資料/参考資料");
	});

	test.each([
		[[createRuleSegment("year", 0)], "科目"],
		[[createRuleSegment("course", 0), createRuleSegment("course", 1)], "重複"],
		[
			[
				createRuleSegment("course", 0),
				createRuleSegment("assignment", 1),
				createRuleSegment("assignment", 2),
			],
			"重複",
		],
		[[createRuleSegment("course", 0), createRuleSegment("fixed", 1, "")], "入力"],
		[[createRuleSegment("course", 0), createRuleSegment("fixed", 1, " 配布資料")], "前後"],
		[[createRuleSegment("course", 0), createRuleSegment("fixed", 1, "{course}")], "波括弧"],
		[[createRuleSegment("course", 0), createRuleSegment("fixed", 1, "{year}")], "波括弧"],
		[[createRuleSegment("course", 0), createRuleSegment("fixed", 1, "第{section}回")], "波括弧"],
		[
			[createRuleSegment("course", 0), createRuleSegment("fixed", 1, "C:\\Users\\student")],
			"絶対パス",
		],
		[[createRuleSegment("course", 0), createRuleSegment("fixed", 1, "..")], ".."],
		[[createRuleSegment("course", 0), createRuleSegment("fixed", 1, "CON")], "予約名"],
	])("構造化ルールの不正値を説明付きで拒否する", (segments, message) => {
		expect(validateRuleSegments(segments)).toContain(message);
	});

	test.each([
		[
			{
				splitBySection: false,
				patternTemplate: "{course}/{section}",
				note: null,
			},
			"外して",
		],
		[
			{
				splitBySection: true,
				patternTemplate: "{course}",
				note: null,
			},
			"追加して",
		],
	])("授業回の検証は内部表現を出さず操作を案内する", (override, action) => {
		const message = validateCourseRuleOverride(override, "{course}");

		expect(message).toContain("授業回");
		expect(message).toContain(action);
		expect(message).not.toContain("{section}");
		expect(message).not.toContain("テンプレート");
	});
});

describe("RuleManagementStore", () => {
	test("拡張機能runtimeがない場合はサンプルへ退避せず接続エラーにする", async () => {
		const store = createRuleManagementStore();

		expect(store.mode).toBe("native");
		await expect(store.load()).rejects.toMatchObject({ code: "NO_NATIVE_HOST" });
		expect(store.snapshot.rules).toBeNull();
		expect(store.snapshot.status).toBe("error");
	});

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
	test("読み取れない内部表現を画面へ出さず、安全な並びと一般的な案内へ退避する", () => {
		const { document, window } = parseHTML("<html><head></head><body></body></html>");
		Object.assign(globalThis, {
			document,
			window,
			HTMLElement: window.HTMLElement,
		});
		const builder = createStructuredRuleBuilder({
			idPrefix: "unsafe-saved-rule",
			initialTemplate: "{course}/{unknown}",
			previewValues: createRulePreviewValues(new Date("2026-05-01T00:00:00+09:00")),
			previewLabel: "保存例",
			onChange: () => {},
			onClearMessage: () => {},
		});
		document.body.append(builder.root);

		expect(builder.root.textContent).not.toContain("{course}");
		expect(builder.root.textContent).not.toContain("{unknown}");
		expect(
			[...builder.root.querySelectorAll<HTMLInputElement>('input[type="text"]')].map(
				(input) => input.value,
			),
		).not.toContain("{unknown}");
		expect(builder.root.querySelector(".fuzzy-rules-validation")?.textContent).toContain(
			"この画面で読み取れませんでした",
		);
		expect(builder.getPreview()).toBe("アプリ演習 / 第05回制作課題");
	});

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

		expect(screen.root.querySelector("h1")?.textContent).toBe("資料の保存方法を設定");
		expect(screen.root.querySelector(".fuzzy-rules-message.is-mock")?.textContent).toContain(
			"再起動後にリセット",
		);
		expect(screen.root.querySelectorAll(".fuzzy-rules-preset")).toHaveLength(RULE_PRESETS.length);

		const panels = [...screen.root.querySelectorAll<HTMLElement>(".fuzzy-rules-panel")];
		const globalPanel = panels.find(
			(panel) => panel.querySelector("h2")?.textContent === "基本の保存設定",
		);
		const coursePanel = panels.find(
			(panel) => panel.querySelector("h2")?.textContent === "授業ごとの保存設定",
		);
		if (!globalPanel || !coursePanel) throw new Error("保存設定パネルがありません。");

		expect(globalPanel.querySelectorAll(".fuzzy-rule-builder-row")).toHaveLength(3);
		expect(globalPanel.textContent).toContain("選んだ保存先");
		expect(globalPanel.textContent).not.toContain("保存ルート");
		expect(globalPanel.textContent).not.toContain("{course}");
		expect(coursePanel.textContent).toContain("この授業での保存例");
		expect(coursePanel.textContent).not.toContain("このコース");
		expect(coursePanel.textContent).not.toContain("{term}");
		expect(coursePanel.textContent).not.toContain("{course}");
		expect(screen.root.textContent).not.toMatch(/\{(?:year|term|course|assignment|section)\}/);
		const courseCard = coursePanel.querySelector<HTMLElement>(".fuzzy-rules-override-card");
		if (!courseCard) throw new Error("授業別設定がありません。");
		expect(courseCard.querySelectorAll(".fuzzy-rule-builder-row")).toHaveLength(2);
		expect(
			[
				...courseCard.querySelectorAll<HTMLOptionElement>(
					'select[aria-label="追加するフォルダー"] option',
				),
			].map((option) => option.textContent),
		).toEqual(["年度", "学期", "科目", "課題", "授業回", "固定フォルダー名"]);
		expect(courseCard.querySelector(".fuzzy-rules-preview-value")?.textContent).toContain(
			"アプリ演習",
		);
		const basicMode = courseCard.querySelector<HTMLInputElement>('input[value="global"]');
		const customMode = courseCard.querySelector<HTMLInputElement>('input[value="custom"]');
		expect(basicMode?.checked).toBe(false);
		expect(customMode?.checked).toBe(true);
		if (!basicMode || !customMode) throw new Error("基本設定を継承する選択肢がありません。");
		basicMode.checked = true;
		customMode.checked = false;
		basicMode.dispatchEvent(new window.Event("change", { bubbles: true }));
		expect(courseCard.querySelector<HTMLElement>(".fuzzy-structured-rule-builder")?.hidden).toBe(
			true,
		);
		expect(courseCard.querySelector(".fuzzy-rules-kind-badge")?.textContent).toBe("基本設定を使用");

		const courseRow = [
			...globalPanel.querySelectorAll<HTMLElement>(".fuzzy-rule-builder-row"),
		].find((row) => row.querySelector("select")?.value === "course");
		if (!courseRow) throw new Error("科目の選択欄がありません。");
		const removeCourse = [...courseRow.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "削除",
		);
		removeCourse?.click();
		expect(globalPanel.querySelector(".fuzzy-rules-validation")?.textContent).toContain("科目");
		expect(globalPanel.querySelector<HTMLButtonElement>(".fuzzy-rules-save-button")?.disabled).toBe(
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

	test.each([
		[{ loadingCourses: true, courseLoadError: null }, "授業を読み込んでいます…"],
		[{ loadingCourses: false, courseLoadError: "接続できません" }, "授業を読み込めませんでした"],
		[{ loadingCourses: false, courseLoadError: null }, "追加できる授業はありません"],
	])("授業一覧の状態を利用者向け用語で表示する", (state, expected) => {
		const { document, window } = parseHTML("<html><head></head><body></body></html>");
		Object.assign(globalThis, {
			document,
			window,
			HTMLElement: window.HTMLElement,
		});
		const panel = buildCourseRulePanel({
			rules: { globalPatternTemplate: "{course}", courseOverrides: [] },
			courses: [],
			drafts: new Map(),
			selectedCourseId: null,
			loadingCourses: state.loadingCourses,
			courseLoadError: state.courseLoadError,
			savingTarget: null,
			previewValues: createRulePreviewValues(),
			isMock: false,
			onSelectedCourseChange: () => {},
			onClearMessage: () => {},
			onAdd: () => {},
			onSave: () => {},
		});

		expect(panel.querySelector("select option")?.textContent).toBe(expected);
		expect(panel.textContent).not.toContain("コースを");
	});

	test("読込失敗時は内部エラーを隠し、次の操作を1か所だけ表示する", async () => {
		const { document, window } = parseHTML("<html><head></head><body></body></html>");
		Object.assign(globalThis, {
			document,
			window,
			HTMLElement: window.HTMLElement,
		});
		const fail = async (): Promise<never> => {
			throw new Error("SQLite DBのbackground応答を取得できません");
		};
		const api: RuleManagementApi = {
			mode: "native",
			getRules: fail,
			updateGlobalRule: fail,
			updateCourseRuleOverride: fail,
			getRuleViolations: fail,
			getDuplicateGroups: fail,
		};
		const screen = createRuleManagementScreen({
			store: new RuleManagementStore(api),
			loadCourses: async () => [],
		});
		document.body.append(screen.root);

		await screen.activate();

		const text = screen.root.textContent ?? "";
		const guidance = "保存・整理設定を更新できませんでした。接続を確認し、再読み込みしてください。";
		expect(text).not.toContain("SQLite");
		expect(text).not.toContain("DB");
		expect(text).not.toContain("background");
		expect(text.split(guidance)).toHaveLength(2);
		expect(screen.root.querySelectorAll('[role="alert"]')).toHaveLength(1);
		expect(screen.root.querySelector(".fuzzy-error-panel")?.textContent).toContain("再読み込み");
	});
});
