import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
	ExtensionInstallError,
	createDestinationOpenedStateInput,
	createInitialExtensionInstallState,
	createSupportedBrowserOptions,
	detectSupportedBrowser,
	getExtensionInstallChannelForState,
	getExtensionInstallDestination,
	getPreferredExtensionInstallChannel,
	isExtensionInstallStateForDestination,
	openExtensionInstallDestinationClient,
	parseExtensionInstallState,
} from "../../apps/desktop/src/lib/setup/extension-install";
import type { ExtensionInstallRuntime } from "../../apps/desktop/src/lib/setup/extension-install";

const storeReadyOptions = createSupportedBrowserOptions({
	chrome: "https://chromewebstore.google.com/detail/fuzzy/abcdefghijklmnop",
	edge: "https://microsoftedge.microsoft.com/addons/detail/fuzzy/abcdefghijklmnop",
});

function createRuntimeMock(options?: {
	resolvedPath?: string;
	resolveError?: boolean;
	openError?: boolean;
}) {
	const resolvedResources: string[] = [];
	const revealedPaths: string[] = [];
	const openedUrls: Array<{ url: string; openWith?: string }> = [];
	const runtime: ExtensionInstallRuntime = {
		resolveResource: async (resourcePath) => {
			resolvedResources.push(resourcePath);

			if (options?.resolveError) {
				throw new Error("resolve failed");
			}

			return (
				options?.resolvedPath ?? "C:\\Program Files\\Fuzzy\\extension\\chrome-mv3\\manifest.json"
			);
		},
		revealItemInDir: async (path) => {
			revealedPaths.push(path);
		},
		openUrl: async (url, openWith) => {
			openedUrls.push({ url, openWith });

			if (options?.openError) {
				throw new Error("open failed");
			}
		},
	};

	return { runtime, resolvedResources, revealedPaths, openedUrls };
}

describe("detectSupportedBrowser", () => {
	test("EdgeをChromeより先に判定する", () => {
		expect(detectSupportedBrowser("Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0")).toBe(
			"edge",
		);
	});

	test("Chromeと未対応ブラウザを判定する", () => {
		expect(detectSupportedBrowser("Mozilla/5.0 Chrome/126.0.0.0")).toBe("chrome");
		expect(detectSupportedBrowser("Mozilla/5.0 Firefox/128.0")).toBe("unsupported");
	});
});

describe("extension install destination", () => {
	test("利用者向け画面からビルドコマンドとスキップ操作を除外する", async () => {
		const componentSource = await Bun.file(
			resolve(import.meta.dir, "../../apps/desktop/src/lib/setup/ExtensionInstallStep.svelte"),
		).text();

		expect(componentSource).toContain("利用者によるビルドやコマンド操作は必要ありません");
		expect(componentSource).not.toContain("bun run build");
		expect(componentSource).not.toContain("今回はスキップ");
	});

	test("公開前はTauriの同梱resourceを既定にする", () => {
		const chrome = getExtensionInstallDestination("chrome", "bundled");
		const edge = getExtensionInstallDestination("edge", "bundled");

		expect(getPreferredExtensionInstallChannel("chrome")).toBe("bundled");
		expect(chrome).toMatchObject({
			available: true,
			displayTarget: "Fuzzyアプリに同梱済み",
			target: {
				kind: "bundled-resource",
				value: "extension/chrome-mv3/manifest.json",
			},
		});
		expect(edge.target).toEqual(chrome.target);
	});

	test("公式ストアURL設定後はstoreを既定にして固定URLだけを許可する", () => {
		expect(getPreferredExtensionInstallChannel("chrome", storeReadyOptions)).toBe("store");
		expect(getExtensionInstallDestination("chrome", "store", storeReadyOptions)).toMatchObject({
			available: true,
			reason: null,
			target: {
				kind: "store-url",
				value: "https://chromewebstore.google.com/detail/fuzzy/abcdefghijklmnop",
				openWith: "chrome.exe",
			},
		});

		const unsafeOptions = createSupportedBrowserOptions({
			chrome: "https://example.com/fuzzy",
			edge: null,
		});
		expect(getPreferredExtensionInstallChannel("chrome", unsafeOptions)).toBe("bundled");
		expect(getExtensionInstallDestination("chrome", "store", unsafeOptions)).toMatchObject({
			available: false,
			target: null,
		});
	});

	test("ストア公開後も確認済みの同梱版へ二重導入を強制しない", () => {
		const bundledState = {
			...createInitialExtensionInstallState("chrome"),
			status: "confirmed" as const,
			completedAt: "2026-07-17T00:00:00.000Z",
		};

		expect(getExtensionInstallChannelForState(bundledState, storeReadyOptions)).toBe("bundled");
		expect(
			getExtensionInstallChannelForState(
				{ ...bundledState, status: "destination-opened" },
				storeReadyOptions,
			),
		).toBe("store");
	});
});

describe("openExtensionInstallDestinationClient", () => {
	test("ブラウザプレビューでは外部アプリを開かずモック結果を返す", async () => {
		const result = await openExtensionInstallDestinationClient("chrome", "bundled", null);

		expect(result).toMatchObject({
			mocked: true,
			openedTarget: "Fuzzyアプリに同梱済み",
		});
	});

	test("同梱manifestの実パスを解決してエクスプローラーに表示する", async () => {
		const mock = createRuntimeMock();
		const result = await openExtensionInstallDestinationClient("edge", "bundled", mock.runtime);

		expect(result.mocked).toBe(false);
		expect(mock.resolvedResources).toEqual(["extension/chrome-mv3/manifest.json"]);
		expect(mock.revealedPaths).toEqual([
			"C:\\Program Files\\Fuzzy\\extension\\chrome-mv3\\manifest.json",
		]);
		expect(mock.openedUrls).toEqual([]);
	});

	test("ストア公開後はブラウザ別の公式URLを開く", async () => {
		const mock = createRuntimeMock();
		await openExtensionInstallDestinationClient("chrome", "store", mock.runtime, storeReadyOptions);

		expect(mock.resolvedResources).toEqual([]);
		expect(mock.revealedPaths).toEqual([]);
		expect(mock.openedUrls).toEqual([
			{
				url: "https://chromewebstore.google.com/detail/fuzzy/abcdefghijklmnop",
				openWith: "chrome.exe",
			},
		]);
	});

	test("未対応・配布先未設定・resource解決失敗を構造化エラーにする", async () => {
		const mock = createRuntimeMock({ resolveError: true });

		await expect(
			openExtensionInstallDestinationClient("unsupported", "bundled", mock.runtime),
		).rejects.toMatchObject({ code: "UNSUPPORTED_BROWSER" });
		await expect(
			openExtensionInstallDestinationClient("chrome", "store", mock.runtime),
		).rejects.toMatchObject({ code: "DESTINATION_UNAVAILABLE" });
		expect(mock.resolvedResources).toEqual([]);

		await expect(
			openExtensionInstallDestinationClient("chrome", "bundled", mock.runtime),
		).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
		expect(mock.resolvedResources).toEqual(["extension/chrome-mv3/manifest.json"]);
	});

	test("公式ストアを開けない場合は再試行可能なエラーにする", async () => {
		const mock = createRuntimeMock({ openError: true });

		await expect(
			openExtensionInstallDestinationClient("edge", "store", mock.runtime, storeReadyOptions),
		).rejects.toBeInstanceOf(ExtensionInstallError);
		expect(mock.openedUrls).toEqual([
			{
				url: "https://microsoftedge.microsoft.com/addons/detail/fuzzy/abcdefghijklmnop",
				openWith: "msedge.exe",
			},
		]);
	});
});

describe("extension install state", () => {
	test("初期状態は同梱版の未開始で、保存値を復元できる", () => {
		const initialState = createInitialExtensionInstallState("chrome");

		expect(initialState).toMatchObject({
			browserId: "chrome",
			channel: "bundled",
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

	test("旧developmentとskippedの保存値を安全に未開始へ移行する", () => {
		expect(
			parseExtensionInstallState({
				browserId: "edge",
				channel: "development",
				status: "skipped",
				lastOpenedAt: "2026-07-17T00:00:00.000Z",
				completedAt: "2026-07-17T00:30:00.000Z",
				updatedAt: "2026-07-17T00:30:00.000Z",
			}),
		).toEqual({
			browserId: "edge",
			channel: "bundled",
			status: "not-started",
			lastOpenedAt: undefined,
			completedAt: undefined,
			updatedAt: "2026-07-17T00:30:00.000Z",
		});
	});

	test("壊れた保存値は復元しない", () => {
		expect(
			parseExtensionInstallState({
				browserId: "firefox",
				channel: "bundled",
				status: "confirmed",
				updatedAt: "2026-07-17T00:00:00.000Z",
			}),
		).toBeNull();
		expect(
			parseExtensionInstallState({
				browserId: "chrome",
				channel: "bundled",
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
			"bundled",
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
				"bundled",
				"2026-07-17T01:00:00.000Z",
			),
		).toMatchObject({ status: "destination-opened" });
	});

	test("保存状態と表示中のブラウザ・配布チャネルが一致する場合だけ確認できる", () => {
		const bundledOpenedState = {
			...createInitialExtensionInstallState("chrome"),
			status: "destination-opened" as const,
			lastOpenedAt: "2026-07-17T01:00:00.000Z",
		};

		expect(isExtensionInstallStateForDestination(bundledOpenedState, "chrome", "bundled")).toBe(
			true,
		);
		expect(isExtensionInstallStateForDestination(bundledOpenedState, "chrome", "store")).toBe(
			false,
		);
		expect(isExtensionInstallStateForDestination(bundledOpenedState, "edge", "bundled")).toBe(
			false,
		);
	});
});
