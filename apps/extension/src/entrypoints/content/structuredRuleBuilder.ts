import {
	RULE_SEGMENT_KINDS,
	RULE_SEGMENT_LABELS,
	type RulePreviewValues,
	type RuleSegment,
	type RuleSegmentKind,
	createRuleSegment,
	createRuleSegmentsFromTemplate,
	previewRuleSegments,
	ruleSegmentsToTemplate,
	validateRuleSegments,
} from "@fuzzy/shared";
import { element, optionElement } from "./rulesScreenElements";

export interface StructuredRuleBuilderOptions {
	idPrefix: string;
	initialTemplate: string;
	previewValues: RulePreviewValues;
	previewLabel: string;
	showPreview?: boolean;
	disabled?: boolean;
	onChange(template: string, segments: readonly RuleSegment[]): void;
	onClearMessage(): void;
}

export interface StructuredRuleBuilder {
	root: HTMLElement;
	getSegments(): readonly RuleSegment[];
	getTemplate(): string;
	getPreview(): string;
	getValidationError(): string | null;
	refreshSummary(): void;
	replaceTemplate(template: string): void;
}

type FocusRequest =
	| { segmentId: string; control: "select" | "up" | "down" }
	| { control: "add-kind" };

const unsupportedSavedRuleMessage =
	"保存済みのフォルダーの並びをこの画面で読み取れませんでした。表示中の並びを確認し、いずれかの項目を変更してから保存してください。";

function createSegmentsForUi(template: string): {
	segments: RuleSegment[];
	sourceWarning: string | null;
} {
	const parsed = createRuleSegmentsFromTemplate(template);
	const wouldExposeInternalExpression = parsed.some(
		(segment) => segment.kind === "fixed" && /[{}]/.test(segment.value ?? ""),
	);
	if (!wouldExposeInternalExpression) return { segments: parsed, sourceWarning: null };
	return {
		segments: createRuleSegmentsFromTemplate("{course}/{assignment}"),
		sourceWarning: unsupportedSavedRuleMessage,
	};
}

export function previewStructuredRuleTemplate(template: string, values: RulePreviewValues): string {
	return previewRuleSegments(createSegmentsForUi(template).segments, values);
}

/**
 * 保存形式の内部表現を画面へ出さず、フォルダー単位で編集するための共通UI。
 * グローバル設定と授業別設定の双方で同じ操作・検証・読み上げを提供する。
 */
export function createStructuredRuleBuilder(
	options: StructuredRuleBuilderOptions,
): StructuredRuleBuilder {
	const initialState = createSegmentsForUi(options.initialTemplate);
	let segments = initialState.segments;
	let sourceWarning = initialState.sourceWarning;
	let validationError: string | null = null;

	const root = element("section", "fuzzy-structured-rule-builder");
	const heading = element("h4", "fuzzy-rule-builder-heading", "フォルダーの並び");
	heading.id = `${options.idPrefix}-builder-heading`;
	const description = element(
		"p",
		"fuzzy-rules-help",
		"上から順にフォルダーを作ります。種類の変更、並べ替え、削除ができます。",
	);
	description.id = `${options.idPrefix}-builder-description`;

	const rows = element("div", "fuzzy-rule-builder");
	rows.setAttribute("role", "group");
	rows.setAttribute("aria-labelledby", heading.id);
	rows.setAttribute("aria-describedby", description.id);

	const addRow = element("div", "fuzzy-rule-builder-add");
	const addField = element("label", "fuzzy-rules-field");
	const addLabel = element("span", "", "追加するフォルダー");
	const addKind = element("select", "fuzzy-rules-select");
	addKind.id = `${options.idPrefix}-add-kind`;
	addKind.setAttribute("aria-label", "追加するフォルダー");
	for (const kind of RULE_SEGMENT_KINDS) {
		const option = optionElement(kind, RULE_SEGMENT_LABELS[kind]);
		option.selected = kind === "fixed";
		addKind.append(option);
	}
	addKind.disabled = options.disabled ?? false;
	addField.append(addLabel, addKind);

	const addButton = element("button", "fuzzy-rules-secondary-button", "追加");
	addButton.type = "button";
	addButton.disabled = options.disabled ?? false;
	addButton.setAttribute("aria-describedby", addKind.id);
	addRow.append(addField, addButton);

	const validation = element("p", "fuzzy-rules-validation");
	validation.id = `${options.idPrefix}-validation`;
	validation.setAttribute("role", "alert");
	validation.setAttribute("aria-live", "assertive");

	const previewValue = element("p", "fuzzy-rules-preview-value");
	previewValue.id = `${options.idPrefix}-preview`;
	previewValue.setAttribute("aria-live", "polite");
	const preview = element("div", "fuzzy-rules-preview");
	preview.append(element("p", "fuzzy-rules-preview-label", options.previewLabel), previewValue);

	const announcement = element("p", "fuzzy-visually-hidden");
	announcement.setAttribute("role", "status");
	announcement.setAttribute("aria-live", "polite");
	announcement.setAttribute("aria-atomic", "true");

	const updateSummary = () => {
		validationError = sourceWarning ?? validateRuleSegments(segments);
		validation.textContent = validationError ?? "";
		validation.hidden = validationError === null;
		rows.setAttribute("aria-invalid", String(validationError !== null));
		previewValue.textContent = previewRuleSegments(segments, options.previewValues);
	};

	const announce = (message: string) => {
		announcement.textContent = "";
		announcement.textContent = message;
	};

	const focusRequestedControl = (request: FocusRequest | undefined) => {
		if (!request) return;
		if (request.control === "add-kind") {
			addKind.focus();
			return;
		}
		const row = [...rows.querySelectorAll<HTMLElement>(".fuzzy-rule-builder-row")].find(
			(candidate) => candidate.dataset.segmentId === request.segmentId,
		);
		if (!row) return;
		const selector =
			request.control === "select" ? "select" : `button[data-builder-action="${request.control}"]`;
		row.querySelector<HTMLElement>(selector)?.focus();
	};

	const emitChange = () => {
		options.onClearMessage();
		options.onChange(ruleSegmentsToTemplate(segments), [...segments]);
	};

	const renderRows = (focusRequest?: FocusRequest) => {
		rows.replaceChildren();
		segments.forEach((segment, index) => {
			const row = element(
				"div",
				segment.kind === "fixed"
					? "fuzzy-rule-builder-row has-fixed-value"
					: "fuzzy-rule-builder-row",
			);
			row.dataset.segmentId = segment.id;
			row.setAttribute("role", "group");
			row.setAttribute("aria-label", `${index + 1}番目: ${RULE_SEGMENT_LABELS[segment.kind]}`);

			const select = element("select", "fuzzy-rules-select");
			select.setAttribute("aria-label", `${index + 1}番目のフォルダー`);
			select.disabled = options.disabled ?? false;
			for (const kind of RULE_SEGMENT_KINDS) {
				const option = optionElement(kind, RULE_SEGMENT_LABELS[kind]);
				option.selected = segment.kind === kind;
				select.append(option);
			}
			select.addEventListener("change", () => {
				const kind = select.value as RuleSegmentKind;
				const replacement = createRuleSegment(kind, index, segment.value);
				segments[index] = replacement;
				sourceWarning = null;
				renderRows({ segmentId: replacement.id, control: "select" });
				announce(`${index + 1}番目を${RULE_SEGMENT_LABELS[kind]}に変更しました。`);
				emitChange();
			});
			row.append(select);

			if (segment.kind === "fixed") {
				const input = element("input", "fuzzy-rules-input");
				input.type = "text";
				input.setAttribute("aria-label", `${index + 1}番目の固定フォルダー名`);
				input.setAttribute("aria-describedby", validation.id);
				input.setAttribute("placeholder", "例: 配布資料");
				input.autocomplete = "off";
				input.value = segment.value ?? "";
				input.disabled = options.disabled ?? false;
				input.addEventListener("input", () => {
					segments[index] = { ...segment, value: input.value };
					sourceWarning = null;
					updateSummary();
					emitChange();
				});
				row.append(input);
			}

			const actions = element("div", "fuzzy-rule-builder-actions");
			const up = element("button", "fuzzy-rules-secondary-button", "上へ");
			up.type = "button";
			up.disabled = (options.disabled ?? false) || index === 0;
			up.dataset.builderAction = "up";
			up.setAttribute("aria-label", `${RULE_SEGMENT_LABELS[segment.kind]}を上へ移動`);
			up.addEventListener("click", () => {
				const previous = segments[index - 1];
				if (!previous) return;
				segments.splice(index - 1, 2, segment, previous);
				sourceWarning = null;
				renderRows({ segmentId: segment.id, control: "up" });
				announce(`${RULE_SEGMENT_LABELS[segment.kind]}を${index}番目へ移動しました。`);
				emitChange();
			});

			const down = element("button", "fuzzy-rules-secondary-button", "下へ");
			down.type = "button";
			down.disabled = (options.disabled ?? false) || index === segments.length - 1;
			down.dataset.builderAction = "down";
			down.setAttribute("aria-label", `${RULE_SEGMENT_LABELS[segment.kind]}を下へ移動`);
			down.addEventListener("click", () => {
				const next = segments[index + 1];
				if (!next) return;
				segments.splice(index, 2, next, segment);
				sourceWarning = null;
				renderRows({ segmentId: segment.id, control: "down" });
				announce(`${RULE_SEGMENT_LABELS[segment.kind]}を${index + 2}番目へ移動しました。`);
				emitChange();
			});

			const remove = element("button", "fuzzy-rules-secondary-button", "削除");
			remove.type = "button";
			remove.disabled = options.disabled ?? false;
			remove.dataset.builderAction = "remove";
			remove.setAttribute("aria-label", `${RULE_SEGMENT_LABELS[segment.kind]}を削除`);
			remove.addEventListener("click", () => {
				const remaining = segments.filter((_, segmentIndex) => segmentIndex !== index);
				const focusTarget = remaining[index] ?? remaining[index - 1];
				segments = remaining;
				sourceWarning = null;
				renderRows(
					focusTarget ? { segmentId: focusTarget.id, control: "select" } : { control: "add-kind" },
				);
				announce(`${RULE_SEGMENT_LABELS[segment.kind]}を削除しました。`);
				emitChange();
			});

			actions.append(up, down, remove);
			row.append(actions);
			rows.append(row);
		});
		updateSummary();
		focusRequestedControl(focusRequest);
	};

	addButton.addEventListener("click", () => {
		const kind = addKind.value as RuleSegmentKind;
		const added = createRuleSegment(kind, segments.length);
		segments = [...segments, added];
		sourceWarning = null;
		renderRows({ segmentId: added.id, control: "select" });
		announce(`${RULE_SEGMENT_LABELS[kind]}を${segments.length}番目に追加しました。`);
		emitChange();
	});

	root.append(heading, description, rows, addRow, validation);
	if (options.showPreview !== false) root.append(preview);
	root.append(announcement);
	renderRows();

	return {
		root,
		getSegments: () => [...segments],
		getTemplate: () => ruleSegmentsToTemplate(segments),
		getPreview: () => previewRuleSegments(segments, options.previewValues),
		getValidationError: () => validationError,
		refreshSummary: updateSummary,
		replaceTemplate: (template) => {
			const replacement = createSegmentsForUi(template);
			segments = replacement.segments;
			sourceWarning = replacement.sourceWarning;
			renderRows(segments[0] ? { segmentId: segments[0].id, control: "select" } : undefined);
			announce("選んだ並びに変更しました。");
			emitChange();
		},
	};
}
