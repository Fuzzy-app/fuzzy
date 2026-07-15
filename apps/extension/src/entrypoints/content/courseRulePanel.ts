import type {
	CourseDashboardEntry,
	CourseRuleOverride,
	RulePreviewValues,
	RuleSet,
} from "@fuzzy/shared";
import { element, optionElement } from "./rulesScreenElements";
import {
	type CourseRuleDraft,
	effectivePattern,
	getAvailableCourses,
	isSameCourseRuleDraft,
	previewPattern,
	validateCourseRuleDraft,
} from "./rulesScreenModel";

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
}

export function buildCourseRulePanel(options: CourseRulePanelOptions): HTMLElement {
	const panel = element("section", "fuzzy-rules-panel");
	const head = element("div", "fuzzy-rules-panel-head");
	const title = element("div");
	title.append(
		element("p", "fuzzy-section-label", "コースごとに上書き"),
		element("h2", "", "コース別例外ルール"),
		element(
			"p",
			"fuzzy-rules-panel-copy",
			"「回ごとに保存しない」など、グローバルルールと違うコースだけを追加・編集します。",
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
			element("p", "", "例外ルールはありません。すべてのコースにグローバルルールを適用します。"),
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
	field.append(element("span", "", "例外に追加するコース"));
	const select = element("select", "fuzzy-rules-select");
	select.setAttribute("aria-label", "例外に追加するコース");

	if (options.loadingCourses) {
		select.append(optionElement("", "コースを読み込んでいます…"));
		select.disabled = true;
	} else if (options.courseLoadError) {
		select.append(optionElement("", "コースを読み込めませんでした"));
		select.disabled = true;
	} else if (available.length === 0) {
		select.append(optionElement("", "追加できるコースはありません"));
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
				`コース一覧の取得に失敗しました: ${options.courseLoadError}`,
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
		options.savingTarget === "add" ? "追加中…" : options.isMock ? "サンプルへ追加" : "例外に追加",
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
		element("p", "fuzzy-rules-override-id", `コースID: ${override.courseId}`),
	);
	const kindBadge = element(
		"span",
		draft.splitBySection ? "fuzzy-rules-kind-badge" : "fuzzy-rules-kind-badge is-no-section",
		draft.splitBySection ? "回ごとに分ける" : "回ごとに分けない",
	);
	head.append(title, kindBadge);

	const grid = element("div", "fuzzy-rules-override-grid");
	const splitLabel = element("label", "fuzzy-rules-checkbox");
	const splitInput = element("input");
	splitInput.type = "checkbox";
	splitInput.checked = draft.splitBySection;
	splitLabel.append(
		splitInput,
		element("span", "", "講義回（第1回、第2回…）ごとにフォルダを分ける"),
	);

	const patternField = element("label", "fuzzy-rules-field");
	const patternInput = element("input", "fuzzy-rules-input");
	patternInput.type = "text";
	patternInput.value = draft.patternTemplate;
	patternInput.placeholder = "空欄ならグローバルルールを継承";
	patternInput.autocomplete = "off";
	const validationText = element("p", "fuzzy-rules-validation");
	patternField.append(
		element("span", "", "このコースのテンプレート"),
		patternInput,
		element("p", "fuzzy-rules-help", "空欄にするとグローバルルールを継承します。"),
		validationText,
	);

	const noteField = element("label", "fuzzy-rules-field");
	const noteInput = element("textarea", "fuzzy-rules-textarea");
	noteInput.value = draft.note;
	noteInput.placeholder = "例外にする理由（任意）";
	noteField.append(element("span", "", "メモ"), noteInput);
	grid.append(splitLabel, patternField, noteField);

	const previewValue = element(
		"p",
		"fuzzy-rules-preview-value",
		previewPattern(
			effectivePattern(draft, options.rules.globalPatternTemplate),
			options.previewValues,
			draft.courseName,
		),
	);
	const preview = element("div", "fuzzy-rules-preview");
	preview.append(element("p", "fuzzy-rules-preview-label", "このコースでの保存例"), previewValue);

	const saveButton = element(
		"button",
		"fuzzy-rules-save-button",
		options.savingTarget === override.courseId
			? "反映中…"
			: options.isMock
				? "サンプルに反映"
				: "この例外を保存",
	);
	saveButton.type = "button";
	const updateCardState = () => {
		const validationError = validateCourseRuleDraft(draft, options.rules.globalPatternTemplate);
		kindBadge.textContent = draft.splitBySection ? "回ごとに分ける" : "回ごとに分けない";
		kindBadge.classList.toggle("is-no-section", !draft.splitBySection);
		validationText.textContent = validationError ?? "";
		validationText.hidden = validationError === null;
		previewValue.textContent = previewPattern(
			effectivePattern(draft, options.rules.globalPatternTemplate),
			options.previewValues,
			draft.courseName,
		);
		saveButton.disabled =
			options.savingTarget !== null ||
			Boolean(validationError) ||
			isSameCourseRuleDraft(draft, override);
	};

	splitInput.addEventListener("change", () => {
		draft.splitBySection = splitInput.checked;
		options.onClearMessage();
		updateCardState();
	});
	patternInput.addEventListener("input", () => {
		draft.patternTemplate = patternInput.value;
		options.onClearMessage();
		updateCardState();
	});
	noteInput.addEventListener("input", () => {
		draft.note = noteInput.value;
		options.onClearMessage();
		updateCardState();
	});
	saveButton.addEventListener("click", () => options.onSave(override.courseId));
	updateCardState();

	const actionRow = element("div", "fuzzy-rules-action-row");
	actionRow.append(saveButton);
	card.append(head, grid, preview, actionRow);
	return card;
}
