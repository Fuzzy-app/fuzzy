import { FUZZY_SCREENS } from "../../lib/ui/screenCopy";

export function buildRulesHeader(): HTMLElement {
	const definition = FUZZY_SCREENS.rules;
	const header = element("header", "fuzzy-screen-header");
	const wrap = element("div");
	wrap.append(
		element("p", "fuzzy-screen-kicker", definition.kicker),
		element("h1", "", definition.title),
		element(
			"p",
			"fuzzy-rules-panel-copy",
			"ここで決めた保存方法は、保存先の提案と整理が必要な資料の確認に使います。保存済みの資料を自動で移動・削除することはありません。",
		),
	);
	header.append(wrap);
	return header;
}

export function buildSummaryCard(
	label: string,
	value: string,
	copy: string,
	modifier = "",
): HTMLElement {
	const card = element(
		"article",
		modifier ? `fuzzy-rules-summary-card ${modifier}` : "fuzzy-rules-summary-card",
	);
	card.append(
		element("p", "fuzzy-rules-summary-label", label),
		element("p", "fuzzy-rules-summary-value", value),
		element("p", "fuzzy-rules-summary-copy", copy),
	);
	return card;
}

export function buildRulesMessage(message: {
	kind: "success" | "error";
	text: string;
}): HTMLElement {
	const box = element(
		"div",
		message.kind === "error" ? "fuzzy-rules-message is-error" : "fuzzy-rules-message",
	);
	box.setAttribute("role", message.kind === "error" ? "alert" : "status");
	box.append(element("p", "", message.text));
	return box;
}

export function optionElement(value: string, label: string): HTMLOptionElement {
	const option = document.createElement("option");
	option.value = value;
	option.textContent = label;
	return option;
}

export function element<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className = "",
	textContent = "",
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (textContent) node.textContent = textContent;
	return node;
}
