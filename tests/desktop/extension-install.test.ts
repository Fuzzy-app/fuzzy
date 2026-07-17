import { describe, expect, test } from "bun:test";
import {
	ExtensionInstallError,
	createDestinationOpenedStateInput,
	createInitialExtensionInstallState,
	detectSupportedBrowser,
	getExtensionInstallDestination,
	openExtensionInstallDestinationClient,
	parseExtensionInstallState,
} from "../../apps/desktop/src/lib/setup/extension-install";

describe("detectSupportedBrowser", () => {
	test("Edge を Chrome より先に判定する", () => {
		expect(detectSupportedBrowser("Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0")).toBe(
			"edge",
		);
	});

	test("Chrome と未対応ブラウザを判定する", () => {
		expect(detectSupportedBrowser("Mozilla/5.0 Chrome/126.0.0.0")).toBe("chrome");
		expect(detectSupportedBrowser("Mozilla/5.0 Firefox/128.0")).toBe("unsupported");
	});
});

describe("getExtensionInstallDestination", () => {
	test("開発版の成果物と公式ガイドだけを案内する", () => {
		const chrome = getExtensionInstallDestination("chrome", "development");
		const edge = getExtensionInstallDestination("edge", "development");

		expect(chrome).toMatchObject({
			available: true,
			displayTarget: "apps/extension/.output/chrome-mv3",
			openTarget:
				"https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked",
		});
		expect(edge).toMatchObject({
			available: true,
			displayTarget: "apps/extension/.output/chrome-mv3",
			openTarget:
				"https://learn.microsoft.com/ja-jp/microsoft-edge/extensions/getting-started/extension-sideloading",
		});
	});

	test("配布URLが未決定の公式ストアは利用不可にする", () => {
		expect(getExtensionInstallDestination("chrome", "store")).toMatchObject({
			available: false,
			openTarget: null,
		});
	});
});

describe("openExtensionInstallDestinationClient", () => {
	test("ブラウザプレビューでは外部URLを開かずモック結果を返す", async () => {
		const result = await openExtensionInstallDestinationClient("chrome", "development", null);

		expect(result.mocked).toBe(true);
	});

	test("明示操作時だけ許可済みの固定URLを opener に渡す", async () => {
		const openedUrls: string[] = [];
		const opener = {
			openUrl: async (url: string) => {
				openedUrls.push(url);
			},
		};

		expect(openedUrls).toEqual([]);
		await openExtensionInstallDestinationClient("edge", "development", opener);

		expect(openedUrls).toEqual([
			"https://learn.microsoft.com/ja-jp/microsoft-edge/extensions/getting-started/extension-sideloading",
		]);
	});

	test("未対応・配布先未設定・opener失敗を構造化エラーにする", async () => {
		let openCount = 0;
		const opener = {
			openUrl: async () => {
				openCount += 1;
				throw new Error("open failed");
			},
		};

		await expect(
			openExtensionInstallDestinationClient("unsupported", "development", opener),
		).rejects.toMatchObject({ code: "UNSUPPORTED_BROWSER" });
		await expect(
			openExtensionInstallDestinationClient("chrome", "store", opener),
		).rejects.toMatchObject({ code: "DESTINATION_UNAVAILABLE" });
		expect(openCount).toBe(0);

		await expect(
			openExtensionInstallDestinationClient("chrome", "development", opener),
		).rejects.toBeInstanceOf(ExtensionInstallError);
		expect(openCount).toBe(1);
	});
});

describe("extension install state", () => {
	test("初期状態は未開始で、保存値を復元できる", () => {
		const initialState = createInitialExtensionInstallState("chrome");

		expect(initialState).toMatchObject({
			browserId: "chrome",
			channel: "development",
			status: "not-started",
		});
		expect(
			parseExtensionInstallState({
				...initialState,
				status: "confirmed",
				completedAt: "2026-07-17T00:00:00.000Z",
			}),
		).toMatchObject({
			browserId: "chrome",
			status: "confirmed",
		});
	});

	test("壊れた保存値は復元しない", () => {
		expect(
			parseExtensionInstallState({
				browserId: "firefox",
				channel: "development",
				status: "confirmed",
				updatedAt: "2026-07-17T00:00:00.000Z",
			}),
		).toBeNull();
		expect(
			parseExtensionInstallState({
				browserId: "chrome",
				channel: "development",
				status: "confirmed",
				completedAt: "invalid-date",
				updatedAt: "2026-07-17T00:00:00.000Z",
			}),
		).toBeNull();
	});

	test("完了後に導入先を開き直しても完了状態を保持する", () => {
		const confirmedState = {
			...createInitialExtensionInstallState("edge"),
			status: "confirmed" as const,
			completedAt: "2026-07-17T00:00:00.000Z",
		};
		const reopened = createDestinationOpenedStateInput(
			confirmedState,
			"edge",
			"development",
			"2026-07-17T01:00:00.000Z",
		);

		expect(reopened).toMatchObject({
			status: "confirmed",
			completedAt: "2026-07-17T00:00:00.000Z",
			lastOpenedAt: "2026-07-17T01:00:00.000Z",
		});
		expect(
			createDestinationOpenedStateInput(
				createInitialExtensionInstallState("chrome"),
				"chrome",
				"development",
				"2026-07-17T01:00:00.000Z",
			),
		).toMatchObject({ status: "destination-opened" });
		expect(
			createDestinationOpenedStateInput(
				{
					...createInitialExtensionInstallState("chrome"),
					status: "skipped",
					completedAt: "2026-07-17T00:30:00.000Z",
				},
				"chrome",
				"development",
				"2026-07-17T01:00:00.000Z",
			),
		).toMatchObject({
			status: "skipped",
			completedAt: "2026-07-17T00:30:00.000Z",
		});
	});
});
