import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseHTML } from "linkedom";

const siteRoot = new URL("../../apps/site/", import.meta.url);

describe("Fuzzy GitHub Pages site", () => {
	test("現在の開発配布と正式公開後の配布を区別している", async () => {
		const html = await readFile(new URL("index.html", siteRoot), "utf8");

		for (const id of ["features", "install", "privacy", "environment", "faq"]) {
			expect(html).toContain(`id="${id}"`);
		}

		expect(html).toContain("Fuzzy for Windows");
		expect(html).toContain("現在は開発・レビュー段階のため");
		expect(html).toContain("開発中の拡張機能はTauriアプリへ同梱しています");
		expect(html).toContain("正式公開後は、Windowsアプリの配布ページと公式ブラウザストア");
		expect(html).toContain("学習状況をひと目で確認");
		expect(html).not.toContain("おかえりなさい");
	});

	test("未公開中は存在しない配布ファイルへ遷移できない", async () => {
		const html = await readFile(new URL("index.html", siteRoot), "utf8");
		const { document } = parseHTML(html);
		const disabledDownloads = [...document.querySelectorAll('[aria-disabled="true"]')];

		expect(document.querySelectorAll('a[href*="/releases/latest/download/"]')).toHaveLength(0);
		expect(disabledDownloads).toHaveLength(4);
		expect(disabledDownloads.every((element) => element.tagName === "SPAN")).toBe(true);
		expect(html).toContain("公開予定");
		expect(html).toContain("Fuzzy-Setup.exe");
		expect(html).toContain("公式ブラウザストア");
		expect(html).toContain("Windows 11");
		expect(html).toContain("Chrome以外も利用可能");
		expect(html).toContain("Chrome限定ではありません");
	});

	test("正式公開後の拡張機能導入手順を最後まで掲載している", async () => {
		const html = await readFile(new URL("index.html", siteRoot), "utf8");

		expect(html).toContain("正式公開後の導入手順");
		expect(html).toContain("公式ストアを開く");
		expect(html).toContain("権限を確認して追加");
		expect(html).toContain("コマンド操作は不要");
		expect(html).not.toContain("デベロッパーモードを有効");
		expect(html).not.toContain("パッケージ化されていない拡張機能を読み込む");
		expect(html).toContain("拡張機能からFuzzyアプリへの実応答を確認");
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

	test("ストア申請に必要な独立プライバシーポリシーを公開対象に含める", async () => {
		const [indexHtml, privacyHtml, viteConfig] = await Promise.all([
			readFile(new URL("index.html", siteRoot), "utf8"),
			readFile(new URL("privacy.html", siteRoot), "utf8"),
			readFile(new URL("vite.config.ts", siteRoot), "utf8"),
		]);

		expect(indexHtml).toContain('href="./privacy.html"');
		expect(viteConfig).toContain('privacy: fileURLToPath(new URL("./privacy.html"');
		expect(privacyHtml).toContain("利用データをFuzzy運営者や第三者のサーバーへ送信しません");
		expect(privacyHtml).toContain("Native Messaging");
		expect(privacyHtml).toContain("Cookieや認証情報をNative Messaging Hostへ渡さず");
		expect(privacyHtml).toContain("資料を自動で移動・削除しません");
		expect(privacyHtml).toContain("FuzzyのGitHub Issues");
	});

	test("GitHub Pages用ワークフローがビルド成果物を公開する", async () => {
		const workflow = await readFile(
			new URL("../../.github/workflows/deploy-pages.yml", import.meta.url),
			"utf8",
		);

		expect(workflow).toContain("bun run build:site");
		expect(workflow).toContain("bun test tests/site/pages-site.test.ts");
		expect(workflow).toContain("pull_request:");
		expect(workflow).toContain('"package.json"');
		expect(workflow).toContain("github.event_name != 'pull_request'");
		expect(workflow).toContain("actions/configure-pages@v5");
		expect(workflow).toContain("actions/upload-pages-artifact@v4");
		expect(workflow).toContain("actions/deploy-pages@v4");
		expect(workflow).toContain("pages: write");
		expect(workflow).toContain("id-token: write");
	});
});
