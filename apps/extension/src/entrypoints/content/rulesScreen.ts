import {
	type CourseDashboardEntry,
	type ExcludedFolder,
	type ExcludedFolderScope,
	type RuleSet,
	removeSectionSegment,
} from "@fuzzy/shared";
import { RuleIntegrityController } from "../../lib/integrity/state";
import type { RuleManagementStore } from "../../lib/rules/state";
import { buildCourseRulePanel } from "./courseRulePanel";
import { buildGlobalRulePanel } from "./globalRulePanel";
import { createRuleIntegrityPanel } from "./ruleIntegrityPanel";
import {
	buildRulesHeader,
	buildRulesMessage,
	buildSummaryCard,
	element,
	optionElement,
} from "./rulesScreenElements";
import {
	type CourseRuleDraft,
	createCourseRuleDraft,
	createScreenPreviewValues,
	dedupeCourses,
	getAvailableCourses,
	patternLabel,
	validateCourseRuleDraft,
	validateRulePattern,
} from "./rulesScreenModel";
import { ensureRulesScreenStyle } from "./rulesScreenStyle";
import { previewStructuredRuleTemplate } from "./structuredRuleBuilder";
import { userFacingErrorMessage } from "./userFacingError";

export interface RuleManagementScreen {
	root: HTMLElement;
	activate(): Promise<void>;
}

export interface RuleManagementScreenOptions {
	store: RuleManagementStore;
	loadCourses: () => Promise<CourseDashboardEntry[]>;
}

export function createRuleManagementScreen(
	options: RuleManagementScreenOptions,
): RuleManagementScreen {
	ensureRulesScreenStyle();

	const root = element("div", "fuzzy-screen fuzzy-rules-screen");
	const integrityPanel = createRuleIntegrityPanel(new RuleIntegrityController(options.store));
	const previewValues = createScreenPreviewValues();
	const overrideDrafts = new Map<number, CourseRuleDraft>();
	let globalDraft = "";
	let courses: CourseDashboardEntry[] = [];
	let selectedCourseId: number | null = null;
	let excludedCourseId: number | null = null;
	let loadingRules = false;
	let loadingCourses = false;
	let rulesLoaded = false;
	let coursesLoaded = false;
	let savingTarget: "global" | number | "add" | null = null;
	let loadPromise: Promise<void> | null = null;
	let message: { kind: "success" | "error"; text: string } | null = null;
	let courseLoadError: string | null = null;
	let excludedFolders: ExcludedFolder[] = [];
	let excludedFoldersLoaded = false;
	let loadingExcludedFolders = false;
	let savingExcludedFolders = false;
	let excludedScope: ExcludedFolderScope = "root";
	let excludedPathDraft = "";
	let activeView: "rules" | "integrity" = "rules";
	let mutationRevision = options.store.snapshot.mutationRevision;

	options.store.subscribe((state) => {
		if (state.mutationRevision === mutationRevision) return;
		mutationRevision = state.mutationRevision;
		integrityPanel.invalidate("violations");
	});

	const clearMessage = () => {
		message = null;
		root.querySelector(".fuzzy-rules-message")?.remove();
	};

	const currentRules = (): RuleSet | null => options.store.snapshot.rules;

	const resetDrafts = (rules: RuleSet) => {
		globalDraft = rules.globalPatternTemplate;
		overrideDrafts.clear();
		for (const override of rules.courseOverrides) {
			overrideDrafts.set(override.courseId, createCourseRuleDraft(override));
		}
	};

	const syncOverrideDraft = (courseId: number, rules: RuleSet) => {
		const override = rules.courseOverrides.find((candidate) => candidate.courseId === courseId);
		if (override) overrideDrafts.set(courseId, createCourseRuleDraft(override));
	};

	const updateSelectedCourse = () => {
		const rules = currentRules();
		const available = getAvailableCourses(courses, rules?.courseOverrides ?? []);
		if (!available.some((course) => course.courseId === selectedCourseId)) {
			selectedCourseId = available[0]?.courseId ?? null;
		}
		if (!courses.some((course) => course.courseId === excludedCourseId)) {
			excludedCourseId = courses[0]?.courseId ?? null;
		}
	};

	const excludedPathsForScope = (scope: ExcludedFolderScope): string[] =>
		excludedFolders.filter((folder) => folder.scope === scope).map((folder) => folder.relativePath);

	const syncExcludedPathDraft = () => {
		excludedPathDraft = excludedPathsForScope(excludedScope).join("\\n");
	};

	const loadExcludedFolders = async () => {
		loadingExcludedFolders = true;
		render();
		try {
			excludedFolders = await options.store.getExcludedFolders(excludedCourseId ?? undefined);
			excludedFoldersLoaded = true;
			syncExcludedPathDraft();
		} catch (error) {
			message = { kind: "error", text: errorMessage(error) };
		} finally {
			loadingExcludedFolders = false;
			render();
		}
	};

	const saveExcludedFolders = async () => {
		if (excludedScope === "course" && excludedCourseId === null) {
			message = {
				kind: "error",
				text: "授業を選択してから授業別の除外フォルダーを設定してください。",
			};
			render();
			return;
		}
		const paths = excludedPathDraft
			.split(/\\r?\\n/)
			.map((path) => path.trim())
			.filter(Boolean);
		savingExcludedFolders = true;
		message = null;
		render();
		try {
			excludedFolders = await options.store.updateExcludedFolders({
				scope: excludedScope,
				courseId: excludedScope === "course" ? excludedCourseId : null,
				paths,
			});
			excludedFoldersLoaded = true;
			syncExcludedPathDraft();
			message = { kind: "success", text: "除外フォルダーを保存しました。" };
		} catch (error) {
			message = { kind: "error", text: errorMessage(error) };
		} finally {
			savingExcludedFolders = false;
			render();
		}
	};

	const buildExcludedFolderPanel = (): HTMLElement => {
		const panel = element("section", "fuzzy-rules-panel");
		const head = element("div", "fuzzy-rules-panel-head");
		const copy = element("div");
		copy.append(
			element("h2", "", "除外フォルダー"),
			element(
				"p",
				"fuzzy-rules-panel-copy",
				"指定したフォルダーは検索・一覧・ルール判定から除外します。ファイル自体を移動・削除することはありません。",
			),
		);
		head.append(copy);
		panel.append(head);

		const scopeField = element("label", "fuzzy-rules-field");
		scopeField.append(element("span", "", "適用範囲"));
		const scopeSelect = element("select", "fuzzy-rules-select") as HTMLSelectElement;
		scopeSelect.append(optionElement("root", "全体"), optionElement("course", "選択した授業のみ"));
		for (const option of Array.from(scopeSelect.options)) {
			option.selected = option.value === excludedScope;
		}
		scopeSelect.disabled = loadingExcludedFolders || savingExcludedFolders;
		scopeSelect.addEventListener("change", () => {
			excludedScope = scopeSelect.value as ExcludedFolderScope;
			excludedFoldersLoaded = false;
			void loadExcludedFolders();
		});
		scopeField.append(scopeSelect);

		if (excludedScope === "course") {
			const courseField = element("label", "fuzzy-rules-field");
			courseField.append(element("span", "", "対象の授業"));
			const courseSelect = element("select", "fuzzy-rules-select") as HTMLSelectElement;
			for (const course of courses) {
				const option = optionElement(String(course.courseId), course.courseName);
				option.selected = course.courseId === excludedCourseId;
				courseSelect.append(option);
			}
			courseSelect.disabled =
				loadingExcludedFolders || savingExcludedFolders || courses.length === 0;
			courseSelect.addEventListener("change", () => {
				excludedCourseId = Number(courseSelect.value);
				excludedFoldersLoaded = false;
				void loadExcludedFolders();
			});
			panel.append(courseField);
			courseField.append(courseSelect);
		}

		const pathField = element("label", "fuzzy-rules-field");
		pathField.append(element("span", "", "除外する相対フォルダー（1行に1つ）"));
		const textarea = element("textarea", "fuzzy-rules-textarea") as HTMLTextAreaElement;
		textarea.value = excludedPathDraft;
		textarea.placeholder = "例: 一時ファイル\n資料/下書き";
		textarea.disabled = loadingExcludedFolders || savingExcludedFolders;
		textarea.addEventListener("input", () => {
			excludedPathDraft = textarea.value;
		});
		pathField.append(textarea);
		pathField.append(
			element(
				"p",
				"fuzzy-rules-help",
				"保存先のルートフォルダーから見た相対パスを指定してください。空欄で設定を解除できます。",
			),
		);

		const actionRow = element("div", "fuzzy-rules-action-row");
		const save = element(
			"button",
			"fuzzy-rules-save-button",
			savingExcludedFolders ? "保存中…" : "除外設定を保存",
		);
		save.type = "button";
		save.disabled =
			loadingExcludedFolders ||
			savingExcludedFolders ||
			(excludedScope === "course" && excludedCourseId === null);
		save.addEventListener("click", () => void saveExcludedFolders());
		actionRow.append(save);
		panel.append(scopeField, pathField, actionRow);

		if (!excludedFoldersLoaded && loadingExcludedFolders) {
			panel.append(element("p", "fuzzy-rules-help", "除外設定を読み込んでいます…"));
		}
		return panel;
	};

	const initialize = async () => {
		if (rulesLoaded && coursesLoaded && excludedFoldersLoaded) return;
		loadingRules = !rulesLoaded;
		loadingCourses = !coursesLoaded;
		message = null;
		render();

		const [rulesResult, coursesResult] = await Promise.allSettled([
			rulesLoaded ? Promise.resolve(currentRules()) : options.store.load(),
			coursesLoaded ? Promise.resolve(courses) : options.loadCourses(),
		]);

		loadingRules = false;
		loadingCourses = false;
		if (rulesResult.status === "fulfilled" && rulesResult.value) {
			rulesLoaded = true;
			resetDrafts(rulesResult.value);
		} else if (rulesResult.status === "rejected") {
			message = { kind: "error", text: errorMessage(rulesResult.reason) };
		}

		if (coursesResult.status === "fulfilled") {
			coursesLoaded = true;
			courses = dedupeCourses(coursesResult.value);
			courseLoadError = null;
		} else {
			courseLoadError = errorMessage(coursesResult.reason);
		}

		updateSelectedCourse();
		if (!excludedFoldersLoaded) await loadExcludedFolders();
		render();
	};

	const activate = () => {
		if (activeView === "integrity") {
			integrityPanel.deactivate();
			return integrityPanel.activate();
		}
		if (loadPromise) return loadPromise;
		loadPromise = initialize().finally(() => {
			loadPromise = null;
		});
		return loadPromise;
	};

	const reloadRules = async () => {
		loadingRules = true;
		message = null;
		render();
		try {
			const rules = await options.store.load();
			rulesLoaded = true;
			resetDrafts(rules);
			updateSelectedCourse();
			message = {
				kind: "success",
				text:
					options.store.mode === "mock"
						? "現在のサンプルルールを読み込みました。"
						: "保存済みの設定を読み込みました。",
			};
		} catch (error) {
			message = { kind: "error", text: errorMessage(error) };
		} finally {
			loadingRules = false;
			render();
		}
	};

	const saveGlobalRule = async () => {
		const validationError = validateRulePattern(globalDraft);
		if (validationError) {
			message = { kind: "error", text: validationError };
			render();
			return;
		}

		savingTarget = "global";
		message = null;
		render();
		try {
			const rules = await options.store.updateGlobalRule({ patternTemplate: globalDraft });
			globalDraft = rules.globalPatternTemplate;
			message = {
				kind: "success",
				text:
					options.store.mode === "mock"
						? "サンプルのグローバルルールへ反映しました。"
						: "基本の保存設定を保存しました。",
			};
		} catch (error) {
			message = { kind: "error", text: errorMessage(error) };
		} finally {
			savingTarget = null;
			render();
		}
	};

	const saveCourseOverride = async (courseId: number) => {
		const rules = currentRules();
		const draft = overrideDrafts.get(courseId);
		if (!rules || !draft) return;

		const validationError = validateCourseRuleDraft(draft, rules.globalPatternTemplate);
		if (validationError) {
			message = { kind: "error", text: `${draft.courseName}: ${validationError}` };
			render();
			return;
		}

		savingTarget = courseId;
		message = null;
		render();
		try {
			const nextRules = await options.store.updateCourseRuleOverride({
				courseId,
				override: {
					splitBySection: draft.splitBySection,
					patternTemplate: draft.patternTemplate.trim() || null,
					note: draft.note.trim() || null,
				},
			});
			syncOverrideDraft(courseId, nextRules);
			message = {
				kind: "success",
				text:
					options.store.mode === "mock"
						? `${draft.courseName}のサンプル例外へ反映しました。`
						: `${draft.courseName}の保存設定を保存しました。`,
			};
		} catch (error) {
			message = { kind: "error", text: errorMessage(error) };
		} finally {
			savingTarget = null;
			render();
		}
	};

	const addCourseOverride = async () => {
		const rules = currentRules();
		const course = courses.find((candidate) => candidate.courseId === selectedCourseId);
		if (!rules || !course) return;

		const defaultPattern = removeSectionSegment(rules.globalPatternTemplate);
		const validationError = validateCourseRuleDraft(
			{
				courseName: course.courseName,
				splitBySection: false,
				patternTemplate: defaultPattern,
				note: "",
			},
			rules.globalPatternTemplate,
		);
		if (validationError) {
			message = { kind: "error", text: `${course.courseName}: ${validationError}` };
			render();
			return;
		}

		savingTarget = "add";
		message = null;
		render();
		try {
			const nextRules = await options.store.updateCourseRuleOverride({
				courseId: course.courseId,
				override: {
					splitBySection: false,
					patternTemplate: defaultPattern,
					note: "この授業は回ごとに保存しない",
				},
			});
			syncOverrideDraft(course.courseId, nextRules);
			updateSelectedCourse();
			message = {
				kind: "success",
				text:
					options.store.mode === "mock"
						? `${course.courseName}をサンプル例外へ追加しました。`
						: `${course.courseName}を授業ごとの保存設定へ追加しました。`,
			};
		} catch (error) {
			message = { kind: "error", text: errorMessage(error) };
		} finally {
			savingTarget = null;
			render();
		}
	};

	const clearCourseOverride = async (courseId: number) => {
		const draft = overrideDrafts.get(courseId);
		if (!draft) return;
		if (!window.confirm(`${draft.courseName}の例外設定を解除し、基本設定に戻しますか？`)) return;
		savingTarget = courseId;
		message = null;
		render();
		try {
			const nextRules = await options.store.clearCourseRuleOverride(courseId);
			resetDrafts(nextRules);
			updateSelectedCourse();
			message = { kind: "success", text: `${draft.courseName}を基本設定に戻しました。` };
		} catch (error) {
			message = { kind: "error", text: errorMessage(error) };
		} finally {
			savingTarget = null;
			render();
		}
	};

	const selectView = (view: "rules" | "integrity") => {
		if (activeView === view) return;
		activeView = view;
		if (view === "integrity") void integrityPanel.activate();
		else integrityPanel.deactivate();
		render();
	};

	const buildTabs = (): HTMLElement => {
		const tabs = element("nav", "fuzzy-rules-tabs");
		tabs.setAttribute("aria-label", "保存と整理の表示内容");
		tabs.setAttribute("role", "tablist");
		const ruleTab = element(
			"button",
			activeView === "rules" ? "fuzzy-rules-tab is-active" : "fuzzy-rules-tab",
			"保存先の設定",
		);
		ruleTab.type = "button";
		ruleTab.id = "fuzzy-rule-settings-tab";
		ruleTab.setAttribute("role", "tab");
		ruleTab.setAttribute("aria-selected", String(activeView === "rules"));
		ruleTab.setAttribute("aria-controls", "fuzzy-rule-settings-panel");
		ruleTab.tabIndex = activeView === "rules" ? 0 : -1;
		const warningTab = element(
			"button",
			activeView === "integrity" ? "fuzzy-rules-tab is-active" : "fuzzy-rules-tab",
			"整理が必要な資料",
		);
		warningTab.type = "button";
		warningTab.id = "fuzzy-rule-integrity-tab";
		warningTab.setAttribute("role", "tab");
		warningTab.setAttribute("aria-selected", String(activeView === "integrity"));
		warningTab.setAttribute("aria-controls", "fuzzy-rule-integrity-panel");
		warningTab.tabIndex = activeView === "integrity" ? 0 : -1;
		ruleTab.addEventListener("click", () => selectView("rules"));
		warningTab.addEventListener("click", () => selectView("integrity"));
		const tabButtons = [ruleTab, warningTab];
		for (const [index, button] of tabButtons.entries()) {
			button.addEventListener("keydown", (event) => {
				let targetIndex: number | null = null;
				if (event.key === "ArrowRight") targetIndex = (index + 1) % tabButtons.length;
				if (event.key === "ArrowLeft") {
					targetIndex = (index - 1 + tabButtons.length) % tabButtons.length;
				}
				if (event.key === "Home") targetIndex = 0;
				if (event.key === "End") targetIndex = tabButtons.length - 1;
				if (targetIndex === null) return;
				event.preventDefault();
				selectView(targetIndex === 0 ? "rules" : "integrity");
				root
					.querySelector<HTMLButtonElement>(
						targetIndex === 0 ? "#fuzzy-rule-settings-tab" : "#fuzzy-rule-integrity-tab",
					)
					?.focus();
			});
		}
		tabs.append(ruleTab, warningTab);
		return tabs;
	};

	const buildOverview = (rules: RuleSet): HTMLElement => {
		const overview = element("section", "fuzzy-rules-overview");
		overview.append(
			buildSummaryCard(
				"現在の基本設定",
				patternLabel(rules.globalPatternTemplate),
				`保存例: ${previewStructuredRuleTemplate(rules.globalPatternTemplate, previewValues)}`,
				"is-accent",
			),
			buildSummaryCard(
				"授業ごとの設定",
				`${rules.courseOverrides.length}件`,
				"基本設定と異なる授業だけを表示します。",
			),
			buildSummaryCard(
				"整理状態の確認",
				"整理が必要な資料を確認",
				"保存設定と異なる資料や、同じ可能性がある資料を確認します。",
				"is-future",
			),
		);
		return overview;
	};

	function render(): void {
		const rules = currentRules();
		root.replaceChildren(buildRulesHeader(), buildTabs());
		if (activeView === "integrity") {
			root.append(integrityPanel.root);
			return;
		}

		const rulesPanel = element("section", "fuzzy-rule-settings-panel");
		rulesPanel.id = "fuzzy-rule-settings-panel";
		rulesPanel.setAttribute("role", "tabpanel");
		rulesPanel.setAttribute("aria-labelledby", "fuzzy-rule-settings-tab");
		root.append(rulesPanel);

		if (rules && options.store.mode === "mock") {
			rulesPanel.append(
				element(
					"div",
					"fuzzy-rules-message is-mock",
					"サンプルモードです。変更は画面確認用で、拡張機能の再起動後にリセットされます。",
				),
			);
		}
		if (message && rules) rulesPanel.append(buildRulesMessage(message));
		if (loadingRules && !rules) {
			rulesPanel.append(
				element("section", "fuzzy-placeholder", "保存済みルールを読み込んでいます…"),
			);
			return;
		}

		if (!rules) {
			const errorPanel = element("section", "fuzzy-error-panel");
			errorPanel.setAttribute("role", "alert");
			const retry = element("button", "fuzzy-primary-button", "再読み込み");
			retry.type = "button";
			retry.addEventListener("click", () => {
				rulesLoaded = false;
				activate();
			});
			const loadError =
				message?.kind === "error" ? message.text : errorMessage(options.store.snapshot.error);
			errorPanel.append(element("p", "", loadError), retry);
			rulesPanel.append(errorPanel);
			return;
		}

		rulesPanel.append(
			buildOverview(rules),
			buildGlobalRulePanel({
				rules,
				draft: globalDraft,
				previewValues,
				savingTarget,
				loadingRules,
				isMock: options.store.mode === "mock",
				onDraftChange: (value) => {
					globalDraft = value;
				},
				onClearMessage: clearMessage,
				onReload: () => void reloadRules(),
				onSave: () => void saveGlobalRule(),
			}),
			buildCourseRulePanel({
				rules,
				courses,
				drafts: overrideDrafts,
				selectedCourseId,
				loadingCourses,
				courseLoadError,
				savingTarget,
				previewValues,
				isMock: options.store.mode === "mock",
				onSelectedCourseChange: (courseId) => {
					selectedCourseId = courseId;
				},
				onClearMessage: clearMessage,
				onAdd: () => void addCourseOverride(),
				onSave: (courseId) => void saveCourseOverride(courseId),
				onClear: (courseId) => void clearCourseOverride(courseId),
			}),
			buildExcludedFolderPanel(),
		);
	}

	render();
	return { root, activate };
}

function errorMessage(error: unknown): string {
	return userFacingErrorMessage(
		error,
		"保存・整理設定を更新できませんでした。接続を確認し、再読み込みしてください。",
	);
}
