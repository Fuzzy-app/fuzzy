import type {
	CourseDashboardEntry,
	CourseRuleOverride,
	RulePreviewValues,
	RuleSet,
} from "@fuzzy/shared";
import { createRuleSegmentsFromTemplate } from "@fuzzy/shared";
import { element, optionElement } from "./rulesScreenElements";
import {
	type CourseRuleDraft,
	getAvailableCourses,
	isSameCourseRuleDraft,
	validateCourseRuleDraft,
} from "./rulesScreenModel";
import { createStructuredRuleBuilder } from "./structuredRuleBuilder";

export interface CourseRulePanelOptions {
	rules: RuleSet;
	courses: CourseDashboardEntry[];
	drafts: Map<number, CourseRuleDraft>;
	selectedCourseId: number | null;
	loadingCourses: boolean;
	courseLoadError: string | null;
	savingTarget: "global" | number | "add" | null;
	previewValues: RulePreviewValues;
	isMock: boolean;
	onSelectedCourseChange(courseId: number | null): void;
	onClearMessage(): void;
	onAdd(): void;
	onSave(courseId: number): void;
	onClear(courseId: number): void;
}

export function buildCourseRulePanel(options: CourseRulePanelOptions): HTMLElement {
	const panel = element("section", "fuzzy-rules-panel");
	const head = element("div", "fuzzy-rules-panel-head");
	const title = element("div");
	title.append(
		element("p", "fuzzy-section-label", "一部の授業だけ保存方法を変更"),
		element("h2", "", "授業ごとの保存設定"),
		element(
			"p",
			"fuzzy-rules-panel-copy",
			"「講義回ごとに分けない」など、基本設定と異なる授業だけを追加します。",
		),
	);
	head.append(
		title,
		element("span", "fuzzy-rules-count-badge", `${options.rules.courseOverrides.length}件`),
	);

	panel.append(head, buildAddRow(options));
	const list = element("div", "fuzzy-rules-override-list");
	if (options.rules.courseOverrides.length === 0) {
		const empty = element("div", "fuzzy-rules-empty");
		empty.append(
			element("p", "", "授業ごとの設定はありません。すべての授業に基本の保存設定を使います。"),
		);
		list.append(empty);
	} else {
		for (const override of options.rules.courseOverrides) {
			list.append(buildOverrideCard(override, options));
		}
	}
	panel.append(list);
	return panel;
}

function buildAddRow(options: CourseRulePanelOptions): HTMLElement {
	const row = element("div", "fuzzy-rules-add-row");
	const available = getAvailableCourses(options.courses, options.rules.courseOverrides);
	const field = element("label", "fuzzy-rules-field");
	field.append(element("span", "", "保存方法を変更する授業"));
	const select = element("select", "fuzzy-rules-select");
	select.setAttribute("aria-label", "保存方法を変更する授業");

	if (options.loadingCourses) {
		select.append(optionElement("", "授業を読み込んでいます…"));
		select.disabled = true;
	} else if (options.courseLoadError) {
		select.append(optionElement("", "授業を読み込めませんでした"));
		select.disabled = true;
	} else if (available.length === 0) {
		select.append(optionElement("", "追加できる授業はありません"));
		select.disabled = true;
	} else {
		for (const course of available) {
			const option = optionElement(String(course.courseId), course.courseName);
			option.selected = course.courseId === options.selectedCourseId;
			select.append(option);
		}
	}

	select.addEventListener("change", () => {
		const parsed = Number(select.value);
		options.onSelectedCourseChange(Number.isInteger(parsed) && parsed > 0 ? parsed : null);
	});
	field.append(select);
	if (options.courseLoadError) {
		field.append(
			element(
				"p",
				"fuzzy-rules-help",
				`授業情報を取得できませんでした: ${options.courseLoadError}`,
			),
		);
	} else {
		field.append(
			element(
				"p",
				"fuzzy-rules-help",
				"追加時は「回ごとに保存しない」を初期値にします。追加後に詳細を編集できます。",
			),
		);
	}

	const addButton = element(
		"button",
		"fuzzy-rules-secondary-button",
		options.savingTarget === "add"
			? "追加中…"
			: options.isMock
				? "サンプルへ追加"
				: "この授業を追加",
	);
	addButton.type = "button";
	addButton.disabled =
		options.savingTarget !== null || options.selectedCourseId === null || available.length === 0;
	addButton.addEventListener("click", options.onAdd);
	row.append(field, addButton);
	return row;
}

function buildOverrideCard(
	override: CourseRuleOverride,
	options: CourseRulePanelOptions,
): HTMLElement {
	const draft = options.drafts.get(override.courseId);
	if (!draft) throw new Error(`コースID ${override.courseId} の編集状態がありません。`);

	const card = element("article", "fuzzy-rules-override-card");
	const head = element("div", "fuzzy-rules-override-head");
	const title = element("div");
	title.append(
		element("h3", "", draft.courseName),
		element("p", "fuzzy-rules-override-id", "この授業だけに適用"),
	);
	let usesGlobalRule = draft.patternTemplate.trim().length === 0;
	const kindBadge = element(
		"span",
		usesGlobalRule ? "fuzzy-rules-kind-badge" : "fuzzy-rules-kind-badge is-no-section",
		usesGlobalRule ? "基本設定を使用" : "授業別に変更",
	);
	head.append(title, kindBadge);

	const modeFieldset = element("fieldset", "fuzzy-rules-choice-group");
	const modeLegend = element("legend", "", "この授業の保存方法");
	const modeName = `fuzzy-course-rule-mode-${override.courseId}`;
	const basicModeLabel = element("label", "fuzzy-rules-radio");
	const basicModeInput = element("input");
	basicModeInput.type = "radio";
	basicModeInput.name = modeName;
	basicModeInput.value = "global";
	basicModeInput.checked = usesGlobalRule;
	basicModeInput.disabled = options.savingTarget !== null;
	basicModeLabel.append(
		basicModeInput,
		element("span", "", "基本の保存設定を使う（基本設定を変更したとき、この授業にも反映）"),
	);
	const customModeLabel = element("label", "fuzzy-rules-radio");
	const customModeInput = element("input");
	customModeInput.type = "radio";
	customModeInput.name = modeName;
	customModeInput.value = "custom";
	customModeInput.checked = !usesGlobalRule;
	customModeInput.disabled = options.savingTarget !== null;
	customModeLabel.append(
		customModeInput,
		element("span", "", "この授業だけフォルダーの並びを変更する"),
	);
	modeFieldset.append(modeLegend, basicModeLabel, customModeLabel);

	let updateCardState = () => {};
	const builder = createStructuredRuleBuilder({
		idPrefix: `fuzzy-course-rule-${override.courseId}`,
		initialTemplate: draft.patternTemplate.trim() || options.rules.globalPatternTemplate,
		previewValues: { ...options.previewValues, course: draft.courseName },
		previewLabel: `${draft.courseName}での保存例`,
		showPreview: false,
		disabled: options.savingTarget !== null,
		onChange: (template, segments) => {
			if (!usesGlobalRule) {
				draft.patternTemplate = template;
				draft.splitBySection = segments.some(({ kind }) => kind === "section");
			}
			updateCardState();
		},
		onClearMessage: options.onClearMessage,
	});
	builder.root.id = `${modeName}-builder`;
	builder.root.hidden = usesGlobalRule;
	customModeInput.setAttribute("aria-controls", builder.root.id);
	customModeInput.setAttribute("aria-expanded", String(!usesGlobalRule));

	const validationText = element("p", "fuzzy-rules-validation");
	validationText.setAttribute("role", "alert");
	validationText.setAttribute("aria-live", "assertive");

	const noteField = element("label", "fuzzy-rules-field");
	const noteInput = element("textarea", "fuzzy-rules-textarea");
	noteInput.value = draft.note;
	noteInput.placeholder = "この授業だけ設定を変える理由（任意）";
	noteInput.disabled = options.savingTarget !== null;
	noteField.append(element("span", "", "メモ"), noteInput);

	const previewValue = element("p", "fuzzy-rules-preview-value", builder.getPreview());
	const preview = element("div", "fuzzy-rules-preview");
	preview.append(element("p", "fuzzy-rules-preview-label", "この授業での保存例"), previewValue);

	const saveButton = element(
		"button",
		"fuzzy-rules-save-button",
		options.savingTarget === override.courseId
			? "反映中…"
			: options.isMock
				? "サンプルに反映"
				: "この授業の設定を保存",
	);
	saveButton.type = "button";
	updateCardState = () => {
		const courseValidationError = validateCourseRuleDraft(
			draft,
			options.rules.globalPatternTemplate,
		);
		const validationError = builder.getValidationError() ?? courseValidationError;
		kindBadge.textContent = usesGlobalRule ? "基本設定を使用" : "授業別に変更";
		kindBadge.classList.toggle("is-no-section", !usesGlobalRule);
		validationText.textContent = validationError ?? "";
		validationText.hidden = validationError === null;
		builder.root.hidden = usesGlobalRule;
		customModeInput.setAttribute("aria-expanded", String(!usesGlobalRule));
		previewValue.textContent = builder.getPreview();
		saveButton.disabled =
			options.savingTarget !== null ||
			Boolean(validationError) ||
			isSameCourseRuleDraft(draft, override);
	};

	basicModeInput.addEventListener("change", () => {
		if (!basicModeInput.checked) return;
		usesGlobalRule = true;
		draft.patternTemplate = "";
		draft.splitBySection = createRuleSegmentsFromTemplate(options.rules.globalPatternTemplate).some(
			({ kind }) => kind === "section",
		);
		options.onClearMessage();
		updateCardState();
	});
	customModeInput.addEventListener("change", () => {
		if (!customModeInput.checked) return;
		usesGlobalRule = false;
		draft.patternTemplate = builder.getTemplate();
		draft.splitBySection = builder.getSegments().some(({ kind }) => kind === "section");
		options.onClearMessage();
		updateCardState();
	});
	noteInput.addEventListener("input", () => {
		draft.note = noteInput.value;
		options.onClearMessage();
		updateCardState();
	});
	saveButton.addEventListener("click", () => options.onSave(override.courseId));
	const clearButton = element("button", "fuzzy-rules-secondary-button", "この授業の例外設定を解除");
	clearButton.type = "button";
	clearButton.disabled = options.savingTarget !== null;
	clearButton.addEventListener("click", () => options.onClear(override.courseId));
	updateCardState();

	const actionRow = element("div", "fuzzy-rules-action-row");
	actionRow.append(saveButton, clearButton);
	card.append(head, modeFieldset, builder.root, validationText, noteField, preview, actionRow);
	return card;
}
