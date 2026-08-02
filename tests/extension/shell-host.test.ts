import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { getShellTopOffset } from "../../apps/extension/src/entrypoints/content/shellHost";

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
});
