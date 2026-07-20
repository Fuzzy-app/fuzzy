import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { createCollapseHandleIcon } from "../../apps/extension/src/entrypoints/content/savePanelHandle";
import {
	SAVE_HANDLE_ID,
	SAVE_HANDLE_WIDTH_PX,
	SAVE_PANEL_ID,
	SAVE_PANEL_MAX_WIDTH_PX,
	SAVE_PANEL_STYLE,
} from "../../apps/extension/src/entrypoints/content/savePanelStyle";

describe("保存パネルの開閉ハンドル", () => {
	test("SVGアイコンを名前空間付き要素と固定viewBoxで生成する", () => {
		const { document } = parseHTML("<html><body></body></html>");
		const icon = createCollapseHandleIcon(document);
		const path = icon.querySelector("path");

		expect(icon.namespaceURI).toBe("http://www.w3.org/2000/svg");
		expect(icon.getAttribute("viewBox")).toBe("0 0 10 16");
		expect(icon.getAttribute("aria-hidden")).toBe("true");
		expect(icon.getAttribute("focusable")).toBe("false");
		expect(path?.getAttribute("d")).toBe("M2 2L8 8L2 14");
		expect(path?.getAttribute("stroke")).toBe("currentColor");
	});

	test("狭い画面でもハンドル幅を残してパネルを収める", () => {
		const responsiveWidth = `min(${SAVE_PANEL_MAX_WIDTH_PX}px, calc(100vw - ${SAVE_HANDLE_WIDTH_PX}px))`;

		expect(SAVE_PANEL_STYLE).toContain(`#${SAVE_PANEL_ID} {`);
		expect(SAVE_PANEL_STYLE).toContain(`width: ${responsiveWidth};`);
		expect(SAVE_PANEL_STYLE).toContain(`#${SAVE_HANDLE_ID} {`);
		expect(SAVE_PANEL_STYLE).toContain(`right: ${responsiveWidth};`);
		expect(SAVE_PANEL_STYLE).toContain(`width: ${SAVE_HANDLE_WIDTH_PX}px;`);
		expect(SAVE_PANEL_STYLE).toContain("padding: 0;");
	});
});
