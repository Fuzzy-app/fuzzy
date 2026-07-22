/** 保存パネル左端の開閉ハンドルに表示するSVGを生成する。 */
export function createCollapseHandleIcon(ownerDocument: Document): SVGSVGElement {
	const icon = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
	icon.setAttribute("viewBox", "0 0 10 16");
	icon.setAttribute("aria-hidden", "true");
	icon.setAttribute("focusable", "false");
	const path = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
	path.setAttribute("d", "M2 2L8 8L2 14");
	path.setAttribute("fill", "none");
	path.setAttribute("stroke", "currentColor");
	path.setAttribute("stroke-width", "2.5");
	path.setAttribute("stroke-linecap", "round");
	path.setAttribute("stroke-linejoin", "round");
	icon.append(path);
	return icon;
}
