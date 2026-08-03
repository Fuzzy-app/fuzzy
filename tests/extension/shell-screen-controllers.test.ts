import { describe, expect, test } from "bun:test";
import type { FuzzyApiClient } from "@fuzzy/shared";
import { parseHTML } from "linkedom";
import { buildDashboardScreen } from "../../apps/extension/src/entrypoints/content/dashboardScreen";
import {
	SearchScreenController,
	aggregateSearchResults,
} from "../../apps/extension/src/entrypoints/content/searchScreen";

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
		const opened: Array<{ fileId: number; page: number | null }> = [];
		const api = {
			mode: "native",
			search: async () => [
				{
					fileId: 4,
					fileName: "第4回_正規化.pdf",
					courseName: "データベース",
					relativePath: "データベース/第4回_正規化.pdf",
					page: 8,
					pageCount: 22,
					snippet: "正規化の第三正規形では部分関数従属を...",
					score: 0.92,
				},
				{
					fileId: 4,
					fileName: "第4回_正規化.pdf",
					courseName: "データベース",
					relativePath: "データベース/第4回_正規化.pdf",
					page: 12,
					pageCount: 22,
					snippet: "正規形の違いを比較します...",
					score: 0.48,
				},
			],
			openFile: async (request: { fileId: number; page: number | null }) => {
				opened.push(request);
				return { opened: true, page: request.page };
			},
		} satisfies Pick<FuzzyApiClient, "mode" | "search" | "openFile">;
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
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(controller.root.textContent).toContain("第4回_正規化.pdf");
		expect(controller.root.textContent).toContain("完全一致 1件 / 近い一致 1件");
		expect(controller.root.querySelectorAll(".fuzzy-result-row")).toHaveLength(1);
		controller.root.querySelector<HTMLButtonElement>(".fuzzy-result-detail")?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(opened).toEqual([{ fileId: 4, page: 8 }]);
		expect(controller.root.textContent).toContain("資料を既定のアプリケーションで開きました。");
	});

	test("同じ資料の同じページを重複させず、複数箇所を件数へまとめる", () => {
		const results = aggregateSearchResults(
			[
				{
					fileId: 1,
					fileName: "資料.pdf",
					courseName: "授業",
					relativePath: "授業/資料.pdf",
					page: 1,
					pageCount: 3,
					snippet: "完全一致",
					score: 1,
				},
				{
					fileId: 1,
					fileName: "資料.pdf",
					courseName: "授業",
					relativePath: "授業/資料.pdf",
					page: 1,
					pageCount: 3,
					snippet: "完全一致",
					score: 0.8,
				},
				{
					fileId: 1,
					fileName: "資料.pdf",
					courseName: "授業",
					relativePath: "授業/資料.pdf",
					page: 2,
					pageCount: 3,
					snippet: "似た表現",
					score: 0.4,
				},
			],
			"完全一致",
		);

		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ exactMatchCount: 1, similarMatchCount: 1 });
	});
});
