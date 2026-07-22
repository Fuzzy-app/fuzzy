import { FUZZY_SCREENS, type FuzzyScreenId } from "../../lib/ui/screenCopy";

const BRAND_ICON_PATH = "/icon/fuzzy.svg";

/** 外部由来の文字列をHTMLとして解釈せず、textContentだけでDOMへ追加する。 */
export function shellElement<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className = "",
	textContent = "",
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (textContent) node.textContent = textContent;
	return node;
}

export function createBrandIcon(className: string): HTMLImageElement {
	const icon = shellElement("img", className);
	icon.src = browser.runtime.getURL(BRAND_ICON_PATH);
	icon.alt = "";
	icon.loading = "eager";
	icon.decoding = "async";
	icon.setAttribute("aria-hidden", "true");
	return icon;
}

export function buildShellScreenHeader(screenId: FuzzyScreenId): HTMLElement {
	const definition = FUZZY_SCREENS[screenId];
	const header = shellElement("header", "fuzzy-screen-header");
	const wrap = shellElement("div");
	wrap.append(
		shellElement("p", "fuzzy-screen-kicker", definition.kicker),
		shellElement("h1", "", definition.title),
	);
	header.append(wrap);
	return header;
}

export function fileKindLabel(fileName: string): string {
	const lower = fileName.toLowerCase();
	if (lower.endsWith(".pdf")) return "PDF";
	if (lower.endsWith(".ppt") || lower.endsWith(".pptx")) return "PPTX";
	if (lower.endsWith(".doc") || lower.endsWith(".docx")) return "DOCX";
	return "FILE";
}

export function fileKindClass(fileName: string): string {
	const lower = fileName.toLowerCase();
	if (lower.endsWith(".pdf")) return "is-pdf";
	if (lower.endsWith(".ppt") || lower.endsWith(".pptx")) return "is-ppt";
	if (lower.endsWith(".doc") || lower.endsWith(".docx")) return "is-doc";
	return "";
}
