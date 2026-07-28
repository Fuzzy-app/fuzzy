import { describe, expect, test } from "bun:test";
import type { FuzzyApiClient } from "@fuzzy/shared";
import { parseHTML } from "linkedom";
import { buildDashboardScreen } from "../../apps/extension/src/entrypoints/content/dashboardScreen";
import { SearchScreenController } from "../../apps/extension/src/entrypoints/content/searchScreen";

function installDom(): void {
	const { document, window } = parseHTML("<html><head></head><body></body></html>");
	Object.assign(globalThis, {
		document,
		window,
		Element: window.Element,
		HTMLElement: window.HTMLElement,
		HTMLButtonElement: window.HTMLButtonElement,
		Event: window.Event,
	});
}

describe("分割したFuzzy画面controller", () => {
	test("整理状況のPresentationStateから再試行可能なエラー画面を作る", () => {
		installDom();
		let reloadCount = 0;
		const screen = buildDashboardScreen(
			{
				dashboard: null,
				cachedAt: null,
				usesCache: false,
				presentation: {
					tone: "error",
					title: "整理状況を読み込めませんでした。",
					impact: "時間をおいて再度お試しください。",
				},
			},
			{
				reload: () => {
					reloadCount += 1;
				},
				openDeadlines: () => {},
			},
		);

		expect(screen.textContent).toContain("整理状況を読み込めませんでした。");
		screen.querySelector<HTMLButtonElement>("button")?.click();
		expect(reloadCount).toBe(1);
	});

	test("検索controllerが入力・取得・表示状態を一つのモデルで更新する", async () => {
		installDom();
		const api = {
			mode: "native",
			search: async () => [
				{
					fileId: 4,
					fileName: "第4回_正規化.pdf",
					courseName: "データベース",
					page: 8,
					pageCount: 22,
					snippet: "第三正規形では部分関数従属を...",
					score: 0.92,
				},
			],
		} satisfies Pick<FuzzyApiClient, "mode" | "search">;
		const controller = new SearchScreenController({
			api: Promise.resolve(api),
			onApiReady: () => {},
		});
		controller.input.value = "正規化";
		controller.input.dispatchEvent(new Event("input"));
		controller.root
			.querySelector<HTMLFormElement>("form")
			?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		await Promise.resolve();
		await Promise.resolve();

		expect(controller.root.textContent).toContain("第4回_正規化.pdf");
		expect(controller.root.textContent).toContain("92%");
	});
});
