import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { getShellTopOffset } from "../../apps/extension/src/entrypoints/content/shellHost";
import { ensureShellStyle } from "../../apps/extension/src/entrypoints/content/shellStyle";

describe("Fuzzy shell frame", () => {
	test("グローバルナビの下へ配置し、非表示にするコース固有ナビの高さを含めない", () => {
		const { document, window } = parseHTML(`
			<html><body>
				<nav class="navbar">
					<div class="primary-navigation"><ul class="nav more-nav"></ul></div>
				</nav>
				<header id="page-header"></header>
				<div class="secondary-navigation"></div>
				<div class="tertiary-navigation"></div>
			</body></html>
		`);
		Object.assign(globalThis, { document, window, HTMLElement: window.HTMLElement });
		const nav = document.querySelector(".nav.more-nav") as HTMLElement;
		const navbar = document.querySelector(".navbar") as HTMLElement;
		const primary = document.querySelector(".primary-navigation") as HTMLElement;
		const pageHeader = document.querySelector("#page-header") as HTMLElement;
		const secondary = document.querySelector(".secondary-navigation") as HTMLElement;
		const tertiary = document.querySelector(".tertiary-navigation") as HTMLElement;
		Object.defineProperty(navbar, "getBoundingClientRect", {
			value: () => ({ bottom: 84 }),
		});
		Object.defineProperty(primary, "getBoundingClientRect", {
			value: () => ({ bottom: 84 }),
		});
		Object.defineProperty(pageHeader, "getBoundingClientRect", {
			value: () => ({ bottom: 220 }),
		});
		Object.defineProperty(secondary, "getBoundingClientRect", {
			value: () => ({ bottom: 259 }),
		});
		Object.defineProperty(tertiary, "getBoundingClientRect", {
			value: () => ({ bottom: 280 }),
		});

		expect(getShellTopOffset(nav)).toBe(84);
	});

	test("シェル表示中はMoodle本文見出しとコース固有ナビを隠し、上部ナビだけを残す", () => {
		const { document, window } = parseHTML("<html><head></head><body></body></html>");
		Object.assign(globalThis, { document, window, HTMLElement: window.HTMLElement });

		ensureShellStyle();
		const css = document.getElementById("fuzzy-shell-style")?.textContent ?? "";

		expect(css).toMatch(
			/body\.fuzzy-shell-open #page-header,\s*body\.fuzzy-shell-open #page-navbar,\s*body\.fuzzy-shell-open \.secondary-navigation,\s*body\.fuzzy-shell-open \.tertiary-navigation\s*\{\s*display: none !important;/,
		);
		expect(css).toMatch(
			/body\.fuzzy-shell-open \.navbar\s*\{\s*position: relative;\s*z-index: 2147483002 !important;/,
		);
		expect(css).not.toMatch(
			/body\.fuzzy-shell-open #page-navbar,\s*body\.fuzzy-shell-open \.navbar\s*\{[^}]*z-index/,
		);
	});
});
