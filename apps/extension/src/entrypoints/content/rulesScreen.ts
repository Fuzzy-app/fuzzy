import type { CourseDashboardEntry } from "@fuzzy/shared";
import type { RuleManagementStore } from "../../lib/rules/state";
import type { CourseRuleOverride, RuleSet } from "../../lib/rules/types";
import { ensureRulesScreenStyle } from "./rulesScreenStyle";

interface RulePreset {
	label: string;
	template: string;
}

interface CourseRuleDraft {
	courseName: string;
	splitBySection: boolean;
	patternTemplate: string;
	note: string;
}

export interface RuleManagementScreen {
	root: HTMLElement;
	activate(): void;
}

export interface RuleManagementScreenOptions {
	store: RuleManagementStore;
	loadCourses: () => Promise<CourseDashboardEntry[]>;
}

const rulePresets: readonly RulePreset[] = [
	{ label: "年度 / 科目 / 課題", template: "{year}/{course}/{assignment}" },
	{ label: "学期 / 科目 / 課題", template: "{term}/{course}/{assignment}" },
	{ label: "科目 / 課題", template: "{course}/{assignment}" },
];

const previewValues: Readonly<Record<string, string>> = {
	year: "2026",
	term: "2026前期",
	course: "アプリ演習",
	assignment: "第05回制作課題",
	section: "05",
};

export function createRuleManagementScreen(
	options: RuleManagementScreenOptions,
): RuleManagementScreen {
	ensureRulesScreenStyle();

	const root = el("div", "fuzzy-screen fuzzy-rules-screen");
	const overrideDrafts = new Map<number, CourseRuleDraft>();
	let globalDraft = "";
	let courses: CourseDashboardEntry[] = [];
	let selectedCourseId: number | null = null;
	let loadingRules = false;
	let loadingCourses = false;
	let rulesLoaded = false;
	let coursesLoaded = false;
	let savingTarget: "global" | number | "add" | null = null;
	let loadPromise: Promise<void> | null = null;
	let message: { kind: "success" | "error"; text: string } | null = null;
	let courseLoadError: string | null = null;
	const clearMessage = () => {
		message = null;
		root.querySelector(".fuzzy-rules-message")?.remove();
	};

	const currentRules = (): RuleSet | null => options.store.snapshot.rules;

	const resetDrafts = (rules: RuleSet) => {
		globalDraft = rules.globalPatternTemplate;
		overrideDrafts.clear();
		for (const override of rules.courseOverrides) {
			overrideDrafts.set(override.courseId, createDraft(override));
		}
	};

	const syncOverrideDraft = (courseId: number, rules: RuleSet) => {
		const override = rules.courseOverrides.find((candidate) => candidate.courseId === courseId);
		if (override) overrideDrafts.set(courseId, createDraft(override));
	};

	const updateSelectedCourse = () => {
		const rules = currentRules();
		const available = getAvailableCourses(courses, rules?.courseOverrides ?? []);
		if (!available.some((course) => course.courseId === selectedCourseId)) {
			selectedCourseId = available[0]?.courseId ?? null;
		}
	};

	const initialize = async () => {
		if (rulesLoaded && coursesLoaded) return;
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
		render();
	};

	const activate = () => {
		if (loadPromise) return;
		loadPromise = initialize().finally(() => {
			loadPromise = null;
		});
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
			message = { kind: "success", text: "保存済みのルールを読み込みました。" };
		} catch (error) {
			message = { kind: "error", text: errorMessage(error) };
		} finally {
			loadingRules = false;
			render();
		}
	};

	const saveGlobalRule = async () => {
		const validationError = validatePattern(globalDraft);
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
			message = { kind: "success", text: "グローバルルールを保存しました。" };
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

		const validationError = validateOverride(draft, rules.globalPatternTemplate);
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
					courseName: draft.courseName,
					splitBySection: draft.splitBySection,
					patternTemplate: draft.patternTemplate.trim() || null,
					note: draft.note.trim() || null,
				},
			});
			syncOverrideDraft(courseId, nextRules);
			message = { kind: "success", text: `${draft.courseName}の例外ルールを保存しました。` };
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
		const validationError = validateOverride(
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
					courseName: course.courseName,
					splitBySection: false,
					patternTemplate: defaultPattern,
					note: "このコースは回ごとに保存しない",
				},
			});
			syncOverrideDraft(course.courseId, nextRules);
			updateSelectedCourse();
			message = { kind: "success", text: `${course.courseName}を例外ルールへ追加しました。` };
		} catch (error) {
			message = { kind: "error", text: errorMessage(error) };
		} finally {
			savingTarget = null;
			render();
		}
	};

	const buildTabs = (): HTMLElement => {
		const tabs = el("nav", "fuzzy-rules-tabs");
		tabs.setAttribute("aria-label", "整理ルールの表示内容");
		const ruleTab = el("button", "fuzzy-rules-tab is-active", "ルール設定");
		ruleTab.type = "button";
		ruleTab.setAttribute("aria-current", "page");
		const warningTab = el("button", "fuzzy-rules-tab", "警告・未整理ファイル");
		warningTab.type = "button";
		warningTab.disabled = true;
		warningTab.title = "issue #53 でルール違反の一覧へ接続します";
		tabs.append(ruleTab, warningTab);
		return tabs;
	};

	const buildOverview = (rules: RuleSet): HTMLElement => {
		const overview = el("section", "fuzzy-rules-overview");
		overview.append(
			buildSummaryCard(
				"現在のグローバルルール",
				patternLabel(rules.globalPatternTemplate),
				rules.globalPatternTemplate,
				"is-accent",
			),
			buildSummaryCard(
				"コース別例外",
				`${rules.courseOverrides.length}件`,
				"グローバルと違う保存方法だけを保持します。",
			),
			buildSummaryCard(
				"警告への接続",
				"同じルールを利用",
				"issue #53 ではこの保存状態を違反・未整理ファイルの判定基準にします。",
				"is-future",
			),
		);
		return overview;
	};

	const buildGlobalPanel = (rules: RuleSet): HTMLElement => {
		const panel = el("section", "fuzzy-rules-panel");
		const head = el("div", "fuzzy-rules-panel-head");
		const title = el("div");
		title.append(
			el("p", "fuzzy-section-label", "すべてのコースに適用"),
			el("h2", "", "グローバルルール"),
			el(
				"p",
				"fuzzy-rules-panel-copy",
				"初期セットアップと同じテンプレート表現で編集します。例外がないコースはこのルールを使います。",
			),
		);
		const reloadButton = el("button", "fuzzy-rules-secondary-button", "保存値を再読み込み");
		reloadButton.type = "button";
		reloadButton.disabled = loadingRules || savingTarget !== null;
		reloadButton.addEventListener("click", () => void reloadRules());
		head.append(title, reloadButton);

		const presetGrid = el("div", "fuzzy-rules-preset-grid");
		const patternInput = el("input", "fuzzy-rules-input");
		patternInput.type = "text";
		patternInput.value = globalDraft;
		patternInput.autocomplete = "off";
		patternInput.setAttribute("aria-label", "グローバルルールのテンプレート");
		const preview = el("p", "fuzzy-rules-preview-value", previewPattern(globalDraft));
		const validationText = el("p", "fuzzy-rules-validation");
		const saveButton = el(
			"button",
			"fuzzy-rules-save-button",
			savingTarget === "global" ? "保存中…" : "グローバルルールを保存",
		);
		saveButton.type = "button";

		const presetButtons = rulePresets.map((preset) => {
			const button = el(
				"button",
				globalDraft === preset.template ? "fuzzy-rules-preset is-active" : "fuzzy-rules-preset",
			);
			button.type = "button";
			button.append(el("strong", "", preset.label), el("code", "", preset.template));
			button.addEventListener("click", () => {
				globalDraft = preset.template;
				patternInput.value = globalDraft;
				updateGlobalForm();
			});
			presetGrid.append(button);
			return { button, preset };
		});

		const updateGlobalForm = () => {
			const validationError = validatePattern(globalDraft);
			preview.textContent = previewPattern(globalDraft);
			validationText.textContent = validationError ?? "";
			validationText.hidden = validationError === null;
			for (const { button, preset } of presetButtons) {
				button.classList.toggle("is-active", globalDraft === preset.template);
			}
			saveButton.disabled =
				savingTarget !== null ||
				Boolean(validationError) ||
				globalDraft.trim() === rules.globalPatternTemplate;
		};

		patternInput.addEventListener("input", () => {
			globalDraft = patternInput.value;
			clearMessage();
			updateGlobalForm();
		});
		saveButton.addEventListener("click", () => void saveGlobalRule());
		updateGlobalForm();

		const field = el("label", "fuzzy-rules-field");
		field.append(
			el("span", "", "テンプレート"),
			patternInput,
			el(
				"p",
				"fuzzy-rules-help",
				"使用できる項目: {year} 年度 / {term} 学期 / {course} 科目 / {assignment} 課題 / {section} 回",
			),
			validationText,
		);

		const previewBox = el("div", "fuzzy-rules-preview");
		previewBox.append(el("p", "fuzzy-rules-preview-label", "アプリ演習での保存例"), preview);
		const actionRow = el("div", "fuzzy-rules-action-row");
		actionRow.append(saveButton);
		panel.append(head, presetGrid, field, previewBox, actionRow);
		return panel;
	};

	const buildOverridePanel = (rules: RuleSet): HTMLElement => {
		const panel = el("section", "fuzzy-rules-panel");
		const head = el("div", "fuzzy-rules-panel-head");
		const title = el("div");
		title.append(
			el("p", "fuzzy-section-label", "コースごとに上書き"),
			el("h2", "", "コース別例外ルール"),
			el(
				"p",
				"fuzzy-rules-panel-copy",
				"「回ごとに保存しない」など、グローバルルールと違うコースだけを追加・編集します。",
			),
		);
		head.append(title, el("span", "fuzzy-rules-count-badge", `${rules.courseOverrides.length}件`));

		panel.append(head, buildAddRow(rules));
		const list = el("div", "fuzzy-rules-override-list");
		if (rules.courseOverrides.length === 0) {
			const empty = el("div", "fuzzy-rules-empty");
			empty.append(
				el("p", "", "例外ルールはありません。すべてのコースにグローバルルールを適用します。"),
			);
			list.append(empty);
		} else {
			for (const override of rules.courseOverrides) {
				list.append(buildOverrideCard(override, rules.globalPatternTemplate));
			}
		}
		panel.append(list);
		return panel;
	};

	const buildAddRow = (rules: RuleSet): HTMLElement => {
		const row = el("div", "fuzzy-rules-add-row");
		const available = getAvailableCourses(courses, rules.courseOverrides);
		const field = el("label", "fuzzy-rules-field");
		field.append(el("span", "", "例外に追加するコース"));
		const select = el("select", "fuzzy-rules-select");
		select.setAttribute("aria-label", "例外に追加するコース");

		if (loadingCourses) {
			select.append(optionElement("", "コースを読み込んでいます…"));
			select.disabled = true;
		} else if (courseLoadError) {
			select.append(optionElement("", "コースを読み込めませんでした"));
			select.disabled = true;
		} else if (available.length === 0) {
			select.append(optionElement("", "追加できるコースはありません"));
			select.disabled = true;
		} else {
			for (const course of available) {
				const option = optionElement(String(course.courseId), course.courseName);
				option.selected = course.courseId === selectedCourseId;
				select.append(option);
			}
		}

		select.addEventListener("change", () => {
			const parsed = Number(select.value);
			selectedCourseId = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
		});
		field.append(select);
		if (courseLoadError) {
			field.append(
				el("p", "fuzzy-rules-help", `コース一覧の取得に失敗しました: ${courseLoadError}`),
			);
		} else {
			field.append(
				el(
					"p",
					"fuzzy-rules-help",
					"追加時は「回ごとに保存しない」を初期値にします。追加後に詳細を編集できます。",
				),
			);
		}

		const addButton = el(
			"button",
			"fuzzy-rules-secondary-button",
			savingTarget === "add" ? "追加中…" : "例外に追加",
		);
		addButton.type = "button";
		addButton.disabled =
			savingTarget !== null || selectedCourseId === null || available.length === 0;
		addButton.addEventListener("click", () => void addCourseOverride());
		row.append(field, addButton);
		return row;
	};

	const buildOverrideCard = (
		override: CourseRuleOverride,
		globalPatternTemplate: string,
	): HTMLElement => {
		const draft = overrideDrafts.get(override.courseId) ?? createDraft(override);
		overrideDrafts.set(override.courseId, draft);

		const card = el("article", "fuzzy-rules-override-card");
		const head = el("div", "fuzzy-rules-override-head");
		const title = el("div");
		title.append(
			el("h3", "", draft.courseName),
			el("p", "fuzzy-rules-override-id", `コースID: ${override.courseId}`),
		);
		const kindBadge = el(
			"span",
			draft.splitBySection ? "fuzzy-rules-kind-badge" : "fuzzy-rules-kind-badge is-no-section",
			draft.splitBySection ? "回ごとに分ける" : "回ごとに分けない",
		);
		head.append(title, kindBadge);

		const grid = el("div", "fuzzy-rules-override-grid");
		const splitLabel = el("label", "fuzzy-rules-checkbox");
		const splitInput = el("input");
		splitInput.type = "checkbox";
		splitInput.checked = draft.splitBySection;
		splitLabel.append(splitInput, el("span", "", "講義回（第1回、第2回…）ごとにフォルダを分ける"));

		const patternField = el("label", "fuzzy-rules-field");
		const patternInput = el("input", "fuzzy-rules-input");
		patternInput.type = "text";
		patternInput.value = draft.patternTemplate;
		patternInput.placeholder = "空欄ならグローバルルールを継承";
		patternInput.autocomplete = "off";
		const validationText = el("p", "fuzzy-rules-validation");
		patternField.append(
			el("span", "", "このコースのテンプレート"),
			patternInput,
			el("p", "fuzzy-rules-help", "空欄にするとグローバルルールを継承します。"),
			validationText,
		);

		const noteField = el("label", "fuzzy-rules-field");
		const noteInput = el("textarea", "fuzzy-rules-textarea");
		noteInput.value = draft.note;
		noteInput.placeholder = "例外にする理由（任意）";
		noteField.append(el("span", "", "メモ"), noteInput);
		grid.append(splitLabel, patternField, noteField);

		const previewValue = el(
			"p",
			"fuzzy-rules-preview-value",
			previewPattern(effectivePattern(draft, globalPatternTemplate), draft.courseName),
		);
		const preview = el("div", "fuzzy-rules-preview");
		preview.append(el("p", "fuzzy-rules-preview-label", "このコースでの保存例"), previewValue);

		const saveButton = el(
			"button",
			"fuzzy-rules-save-button",
			savingTarget === override.courseId ? "保存中…" : "この例外を保存",
		);
		saveButton.type = "button";
		const updateCardState = () => {
			const validationError = validateOverride(draft, globalPatternTemplate);
			kindBadge.textContent = draft.splitBySection ? "回ごとに分ける" : "回ごとに分けない";
			kindBadge.classList.toggle("is-no-section", !draft.splitBySection);
			validationText.textContent = validationError ?? "";
			validationText.hidden = validationError === null;
			previewValue.textContent = previewPattern(
				effectivePattern(draft, globalPatternTemplate),
				draft.courseName,
			);
			saveButton.disabled =
				savingTarget !== null || Boolean(validationError) || isSameOverrideDraft(draft, override);
		};

		splitInput.addEventListener("change", () => {
			draft.splitBySection = splitInput.checked;
			clearMessage();
			updateCardState();
		});
		patternInput.addEventListener("input", () => {
			draft.patternTemplate = patternInput.value;
			clearMessage();
			updateCardState();
		});
		noteInput.addEventListener("input", () => {
			draft.note = noteInput.value;
			clearMessage();
			updateCardState();
		});
		saveButton.addEventListener("click", () => void saveCourseOverride(override.courseId));
		updateCardState();

		const actionRow = el("div", "fuzzy-rules-action-row");
		actionRow.append(saveButton);
		card.append(head, grid, preview, actionRow);
		return card;
	};

	function render(): void {
		const rules = currentRules();
		root.replaceChildren(buildHeader(), buildTabs());

		if (message) root.append(buildMessage(message));
		if (loadingRules && !rules) {
			root.append(el("section", "fuzzy-placeholder", "保存済みルールを読み込んでいます…"));
			return;
		}

		if (!rules) {
			const errorPanel = el("section", "fuzzy-error-panel");
			const retry = el("button", "fuzzy-primary-button", "再読み込み");
			retry.type = "button";
			retry.addEventListener("click", () => {
				rulesLoaded = false;
				activate();
			});
			errorPanel.append(
				el("p", "", options.store.snapshot.error ?? "ルールを読み込めませんでした。"),
				retry,
			);
			root.append(errorPanel);
			return;
		}

		root.append(buildOverview(rules), buildGlobalPanel(rules), buildOverridePanel(rules));
	}

	render();
	return { root, activate };
}

function buildHeader(): HTMLElement {
	const header = el("header", "fuzzy-screen-header");
	const wrap = el("div");
	wrap.append(
		el("p", "fuzzy-screen-kicker", "整理ルール"),
		el("h1", "", "保存ルールを管理"),
		el(
			"p",
			"fuzzy-rules-panel-copy",
			"変更は保存先の提案と警告判定に使います。保存済みファイルの自動移動・自動削除は行いません。",
		),
	);
	header.append(wrap);
	return header;
}

function buildSummaryCard(label: string, value: string, copy: string, modifier = ""): HTMLElement {
	const card = el(
		"article",
		modifier ? `fuzzy-rules-summary-card ${modifier}` : "fuzzy-rules-summary-card",
	);
	card.append(
		el("p", "fuzzy-rules-summary-label", label),
		el("p", "fuzzy-rules-summary-value", value),
		el("p", "fuzzy-rules-summary-copy", copy),
	);
	return card;
}

function buildMessage(message: { kind: "success" | "error"; text: string }): HTMLElement {
	const box = el(
		"div",
		message.kind === "error" ? "fuzzy-rules-message is-error" : "fuzzy-rules-message",
	);
	box.setAttribute("role", message.kind === "error" ? "alert" : "status");
	box.append(el("p", "", message.text));
	return box;
}

function createDraft(override: CourseRuleOverride): CourseRuleDraft {
	return {
		courseName: override.courseName,
		splitBySection: override.splitBySection,
		patternTemplate: override.patternTemplate ?? "",
		note: override.note ?? "",
	};
}

function isSameOverrideDraft(draft: CourseRuleDraft, override: CourseRuleOverride): boolean {
	return (
		draft.courseName.trim() === override.courseName &&
		draft.splitBySection === override.splitBySection &&
		(draft.patternTemplate.trim() || null) === override.patternTemplate &&
		(draft.note.trim() || null) === override.note
	);
}

function effectivePattern(draft: CourseRuleDraft, globalPatternTemplate: string): string {
	return draft.patternTemplate.trim() || globalPatternTemplate;
}

function validatePattern(patternTemplate: string): string | null {
	const normalized = patternTemplate.trim();
	if (!normalized) return "テンプレートを入力してください。";
	if (!normalized.includes("{course}")) return "テンプレートには {course} を含めてください。";
	return null;
}

function validateOverride(draft: CourseRuleDraft, globalPatternTemplate: string): string | null {
	const pattern = effectivePattern(draft, globalPatternTemplate);
	const patternError = validatePattern(pattern);
	if (patternError) return patternError;
	if (!draft.splitBySection && pattern.includes("{section}")) {
		return "回ごとに分けない場合はテンプレートから {section} を外してください。";
	}
	if (draft.splitBySection && !pattern.includes("{section}")) {
		return "回ごとに分ける場合はテンプレートに {section} を含めてください。";
	}
	return null;
}

function removeSectionSegment(patternTemplate: string): string {
	const segments = patternTemplate
		.split(/[\\/]/)
		.map((segment) =>
			segment
				.replace(/第\s*\{section\}\s*回/g, "")
				.replace(/\{section\}/g, "")
				.replace(/(?:\s*[-_–—:：]\s*){2,}/g, "-")
				.replace(/^\s*[-_–—:：]+|[-_–—:：]+\s*$/g, "")
				.trim(),
		)
		.filter(Boolean);
	const patternWithoutSection = segments.join("/");
	if (!patternWithoutSection) return "{course}";
	return patternWithoutSection.includes("{course}")
		? patternWithoutSection
		: `${patternWithoutSection}/{course}`;
}

function previewPattern(patternTemplate: string, courseName = previewValues.course): string {
	const normalized = patternTemplate.trim();
	if (!normalized) return "グローバルルールを継承";
	return normalized.replace(/\{(year|term|course|assignment|section)\}/g, (_match, token) => {
		return token === "course" ? courseName : (previewValues[token] ?? `{${token}}`);
	});
}

function patternLabel(patternTemplate: string): string {
	return (
		rulePresets.find((preset) => preset.template === patternTemplate)?.label ?? "カスタムルール"
	);
}

function getAvailableCourses(
	courses: readonly CourseDashboardEntry[],
	overrides: readonly CourseRuleOverride[],
): CourseDashboardEntry[] {
	const overriddenCourseIds = new Set(overrides.map((override) => override.courseId));
	return courses.filter((course) => !overriddenCourseIds.has(course.courseId));
}

function dedupeCourses(courses: readonly CourseDashboardEntry[]): CourseDashboardEntry[] {
	const byId = new Map<number, CourseDashboardEntry>();
	for (const course of courses) byId.set(course.courseId, course);
	return [...byId.values()].sort((left, right) => left.courseId - right.courseId);
}

function optionElement(value: string, label: string): HTMLOptionElement {
	const option = document.createElement("option");
	option.value = value;
	option.textContent = label;
	return option;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "ルールを更新できませんでした。";
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className = "",
	textContent = "",
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (textContent) node.textContent = textContent;
	return node;
}
