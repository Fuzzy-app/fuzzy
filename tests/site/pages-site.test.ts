import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const siteRoot = new URL("../../apps/site/", import.meta.url);

describe("Fuzzy GitHub Pages site", () => {
	test("主要な案内と導入フローを掲載している", async () => {
		const html = await readFile(new URL("index.html", siteRoot), "utf8");

		for (const id of ["features", "install", "privacy", "environment", "faq"]) {
			expect(html).toContain(`id="${id}"`);
		}

		expect(html).toContain("Fuzzy for Windows");
		expect(html).toContain("現在は開発・レビュー段階です");
		expect(html).toContain("Windowsアプリとブラウザ拡張機能は別々に導入します");
		expect(html).toContain("学習状況をひと目で確認");
		expect(html).not.toContain("おかえりなさい");
	});

	test("アプリと拡張機能をGitHubの一覧画面を経由せず取得できる", async () => {
		const html = await readFile(new URL("index.html", siteRoot), "utf8");

		expect(html).toContain(
			'href="https://github.com/Fuzzy-app/fuzzy/releases/latest/download/Fuzzy-Setup.exe"',
		);
		expect(html).toContain(
			'href="https://github.com/Fuzzy-app/fuzzy/releases/latest/download/Fuzzy-Extension.zip"',
		);
		expect(html).toContain("Chrome以外も利用可能");
		expect(html).toContain("Chrome限定ではありません");
	});

	test("公開リンクはHTTPSを使用する", async () => {
		const html = await readFile(new URL("index.html", siteRoot), "utf8");
		const externalLinks = [...html.matchAll(/href="(https?:\/\/[^\"]+)"/g)]
			.map((match) => match[1])
			.filter((link): link is string => link !== undefined);

		expect(externalLinks.length).toBeGreaterThan(0);
		for (const link of externalLinks) {
			expect(link.startsWith("https://")).toBe(true);
		}
	});

	test("GitHub Pages用ワークフローがビルド成果物を公開する", async () => {
		const workflow = await readFile(
			new URL("../../.github/workflows/deploy-pages.yml", import.meta.url),
			"utf8",
		);

		expect(workflow).toContain("bun run build:site");
		expect(workflow).toContain("actions/configure-pages@v5");
		expect(workflow).toContain("actions/upload-pages-artifact@v4");
		expect(workflow).toContain("actions/deploy-pages@v4");
		expect(workflow).toContain("pages: write");
		expect(workflow).toContain("id-token: write");
	});
});
