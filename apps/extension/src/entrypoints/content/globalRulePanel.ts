import { RULE_PRESETS, type RulePreviewValues, type RuleSet } from "@fuzzy/shared";
import { element } from "./rulesScreenElements";
import { previewPattern, validateRulePattern } from "./rulesScreenModel";

export interface GlobalRulePanelOptions {
	rules: RuleSet;
	draft: string;
	previewValues: RulePreviewValues;
	savingTarget: "global" | number | "add" | null;
	loadingRules: boolean;
	isMock: boolean;
	onDraftChange(value: string): void;
	onClearMessage(): void;
	onReload(): void;
	onSave(): void;
}

export function buildGlobalRulePanel(options: GlobalRulePanelOptions): HTMLElement {
	const panel = element("section", "fuzzy-rules-panel");
	const head = element("div", "fuzzy-rules-panel-head");
	const title = element("div");
	title.append(
		element("p", "fuzzy-section-label", "すべての授業に適用"),
		element("h2", "", "基本の保存設定"),
		element(
			"p",
			"fuzzy-rules-panel-copy",
			"授業ごとの設定がない場合は、この保存方法を使います。",
		),
	);
	const reloadButton = element("button", "fuzzy-rules-secondary-button", "保存値を再読み込み");
	reloadButton.type = "button";
	reloadButton.disabled = options.loadingRules || options.savingTarget !== null;
	reloadButton.addEventListener("click", options.onReload);
	head.append(title, reloadButton);

	let currentDraft = options.draft;
	const presetGrid = element("div", "fuzzy-rules-preset-grid");
	const patternInput = element("input", "fuzzy-rules-input");
	patternInput.type = "text";
	patternInput.value = currentDraft;
	patternInput.autocomplete = "off";
	patternInput.setAttribute("aria-label", "基本の保存先の形式");
	const preview = element(
		"p",
		"fuzzy-rules-preview-value",
		previewPattern(currentDraft, options.previewValues),
	);
	const validationText = element("p", "fuzzy-rules-validation");
	const saveButton = element(
		"button",
		"fuzzy-rules-save-button",
		options.savingTarget === "global"
			? "反映中…"
			: options.isMock
				? "サンプルに反映"
				: "基本設定を保存",
	);
	saveButton.type = "button";

	const presetButtons = RULE_PRESETS.map((preset) => {
		const button = element(
			"button",
			currentDraft === preset.template ? "fuzzy-rules-preset is-active" : "fuzzy-rules-preset",
		);
		button.type = "button";
		button.append(element("strong", "", preset.name), element("code", "", preset.template));
		button.addEventListener("click", () => {
			currentDraft = preset.template;
			options.onDraftChange(currentDraft);
			patternInput.value = currentDraft;
			updateForm();
		});
		presetGrid.append(button);
		return { button, preset };
	});

	const updateForm = () => {
		const validationError = validateRulePattern(currentDraft);
		preview.textContent = previewPattern(currentDraft, options.previewValues);
		validationText.textContent = validationError ?? "";
		validationText.hidden = validationError === null;
		for (const { button, preset } of presetButtons) {
			button.classList.toggle("is-active", currentDraft === preset.template);
		}
		saveButton.disabled =
			options.savingTarget !== null ||
			Boolean(validationError) ||
			currentDraft.trim() === options.rules.globalPatternTemplate;
	};

	patternInput.addEventListener("input", () => {
		currentDraft = patternInput.value;
		options.onDraftChange(currentDraft);
		options.onClearMessage();
		updateForm();
	});
	saveButton.addEventListener("click", options.onSave);
	updateForm();

	const field = element("label", "fuzzy-rules-field");
	field.append(
		element("span", "", "保存先の形式"),
		patternInput,
		element(
			"p",
			"fuzzy-rules-help",
			"使用できる項目: {year} 年度 / {term} 学期 / {course} 科目 / {assignment} 課題 / {section} 回",
		),
		validationText,
	);

	const previewBox = element("div", "fuzzy-rules-preview");
	previewBox.append(element("p", "fuzzy-rules-preview-label", "アプリ演習での保存例"), preview);
	const actionRow = element("div", "fuzzy-rules-action-row");
	actionRow.append(saveButton);
	panel.append(head, presetGrid, field, previewBox, actionRow);
	return panel;
}
