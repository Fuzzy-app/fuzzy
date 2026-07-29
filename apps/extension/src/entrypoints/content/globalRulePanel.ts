import { RULE_PRESETS, type RulePreviewValues, type RuleSet } from "@fuzzy/shared";
import { element } from "./rulesScreenElements";
import { createStructuredRuleBuilder } from "./structuredRuleBuilder";

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
			"保存ルートの下に作るフォルダーを、上から順に並べます。授業ごとの設定がない場合にこの並びを使います。",
		),
	);
	const reloadButton = element("button", "fuzzy-rules-secondary-button", "保存値を再読み込み");
	reloadButton.type = "button";
	reloadButton.disabled = options.loadingRules || options.savingTarget !== null;
	reloadButton.addEventListener("click", options.onReload);
	head.append(title, reloadButton);

	let currentDraft = options.draft;
	const presetGrid = element("div", "fuzzy-rules-preset-grid");
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

	const updateSaveState = (validationError: string | null) => {
		saveButton.disabled =
			options.savingTarget !== null ||
			Boolean(validationError) ||
			currentDraft === options.rules.globalPatternTemplate;
	};

	const builder = createStructuredRuleBuilder({
		idPrefix: "fuzzy-global-rule",
		initialTemplate: options.draft,
		previewValues: options.previewValues,
		previewLabel: "実際のフォルダー名での例",
		disabled: options.savingTarget !== null,
		onChange: (template) => {
			currentDraft = template;
			options.onDraftChange(template);
			updateSaveState(builder.getValidationError());
		},
		onClearMessage: options.onClearMessage,
	});

	for (const preset of RULE_PRESETS) {
		const button = element("button", "fuzzy-rules-preset");
		button.type = "button";
		button.disabled = options.savingTarget !== null;
		button.append(
			element("strong", "", preset.name),
			element("span", "fuzzy-rules-help", preset.description),
		);
		button.addEventListener("click", () => {
			builder.replaceTemplate(preset.template);
		});
		presetGrid.append(button);
	}

	saveButton.addEventListener("click", options.onSave);
	const actionRow = element("div", "fuzzy-rules-action-row");
	actionRow.append(saveButton);
	panel.append(head, presetGrid, builder.root, actionRow);
	updateSaveState(builder.getValidationError());
	return panel;
}
