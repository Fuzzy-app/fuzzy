import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { getShellTopOffset } from "../../apps/extension/src/entrypoints/content/shellHost";
import { ensureShellStyle } from "../../apps/extension/src/entrypoints/content/shellStyle";

describe("Fuzzy shell frame", () => {
	test("keeps the shell below Moodle navigation and page header", () => {
		const { document, window } = parseHTML(`
			<html><body>
				<header><nav><ul class="nav more-nav"></ul></nav></header>
				<div class="secondary-navigation"></div>
			</body></html>
		`);
		Object.assign(globalThis, { document, window, HTMLElement: window.HTMLElement });
		const nav = document.querySelector(".nav.more-nav") as HTMLElement;
		const header = document.querySelector("header") as HTMLElement;
		const secondary = document.querySelector(".secondary-navigation") as HTMLElement;
		Object.defineProperty(header, "getBoundingClientRect", {
			value: () => ({ bottom: 84 }),
		});
		Object.defineProperty(secondary, "getBoundingClientRect", {
			value: () => ({ bottom: 138 }),
		});

		expect(getShellTopOffset(nav)).toBe(138);
	});

	test("シェル表示中はMoodle本文見出しを隠し、上部ナビだけを前面に保つ", () => {
		const { document, window } = parseHTML("<html><head></head><body></body></html>");
		Object.assign(globalThis, { document, window, HTMLElement: window.HTMLElement });

		ensureShellStyle();
		const css = document.getElementById("fuzzy-shell-style")?.textContent ?? "";

		expect(css).toMatch(
			/body\.fuzzy-shell-open #page-header,\s*body\.fuzzy-shell-open #page-navbar\s*\{\s*display: none !important;/,
		);
		expect(css).toMatch(
			/body\.fuzzy-shell-open \.navbar\s*\{\s*position: relative;\s*z-index: 2147483002 !important;/,
		);
		expect(css).not.toMatch(
			/body\.fuzzy-shell-open #page-navbar,\s*body\.fuzzy-shell-open \.navbar\s*\{[^}]*z-index/,
		);
	});
});
