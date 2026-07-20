import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
	ExtensionInstallError,
	getExtensionInstallDestination,
	getExtensionSetupStatusClient,
	getPreferredExtensionInstallChannel,
	isAllowedExtensionStoreUrl,
	openExtensionInstallDestinationClient,
	parseExtensionSetupStatus,
} from "../../apps/desktop/src/lib/setup/extension-install";
import type {
	ExtensionInstallRuntime,
	ExtensionStatusRuntime,
} from "../../apps/desktop/src/lib/setup/extension-install";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const chromeStoreUrl = `https://chromewebstore.google.com/detail/fuzzy/${extensionId}`;
const edgeStoreUrl = `https://microsoftedge.microsoft.com/addons/detail/fuzzy/${extensionId}`;

function createRuntimeMock(options?: {
	resolvedPath?: string;
	resolveError?: boolean;
	openError?: boolean;
}) {
	const resolvedResources: string[] = [];
	const revealedPaths: string[] = [];
	const openedUrls: string[] = [];
	const runtime: ExtensionInstallRuntime = {
		resolveResource: async (resourcePath) => {
			resolvedResources.push(resourcePath);
			if (options?.resolveError) throw new Error("resolve failed");
			return (
				options?.resolvedPath ?? "C:\\Program Files\\Fuzzy\\extension\\chrome-mv3\\manifest.json"
			);
		},
		revealItemInDir: async (path) => {
			revealedPaths.push(path);
		},
		openUrl: async (url) => {
			openedUrls.push(url);
			if (options?.openError) throw new Error("open failed");
		},
	};

	return { runtime, resolvedResources, revealedPaths, openedUrls };
}

describe("browser-independent extension installation", () => {
	test("画面にブラウザ選択・自己申告・スキップを置かない", async () => {
		const componentSource = await Bun.file(
			resolve(import.meta.dir, "../../apps/desktop/src/lib/setup/ExtensionInstallStep.svelte"),
		).text();

		expect(componentSource).toContain("ブラウザの種類を選ぶ必要はありません");
		expect(componentSource).toContain("拡張機能からの応答を待っています");
		expect(componentSource).not.toContain("detectSupportedBrowser");
		expect(componentSource).not.toContain('type="checkbox"');
		expect(componentSource).not.toContain("今回はスキップ");
		expect(componentSource).not.toContain("localStorage");
	});

	test("公開前は同梱版を既定にする", () => {
		expect(getPreferredExtensionInstallChannel()).toBe("bundled");
		expect(getExtensionInstallDestination("bundled")).toMatchObject({
			available: true,
			displayTarget: "Fuzzyアプリに同梱済み",
			target: {
				kind: "bundled-resource",
				value: "extension/chrome-mv3/manifest.json",
			},
		});
	});

	test("ストアの拡張機能詳細ページだけを許可する", () => {
		expect(isAllowedExtensionStoreUrl(chromeStoreUrl)).toBe(true);
		expect(isAllowedExtensionStoreUrl(edgeStoreUrl)).toBe(true);
		expect(isAllowedExtensionStoreUrl("https://chromewebstore.google.com/")).toBe(false);
		expect(
			isAllowedExtensionStoreUrl("https://chromewebstore.google.com/detail/fuzzy/not-an-id"),
		).toBe(false);
		expect(isAllowedExtensionStoreUrl(`https://example.com/detail/fuzzy/${extensionId}`)).toBe(
			false,
		);
	});
});

describe("openExtensionInstallDestinationClient", () => {
	test("ブラウザプレビューでは外部アプリを開かずモック結果を返す", async () => {
		const result = await openExtensionInstallDestinationClient("bundled", null);
		expect(result).toMatchObject({
			mocked: true,
			openedTarget: "Fuzzyアプリに同梱済み",
		});
	});

	test("同梱manifestの実パスを解決してエクスプローラーに表示する", async () => {
		const mock = createRuntimeMock();
		const result = await openExtensionInstallDestinationClient("bundled", mock.runtime);

		expect(result.mocked).toBe(false);
		expect(mock.resolvedResources).toEqual(["extension/chrome-mv3/manifest.json"]);
		expect(mock.revealedPaths).toEqual([
			"C:\\Program Files\\Fuzzy\\extension\\chrome-mv3\\manifest.json",
		]);
		expect(mock.openedUrls).toEqual([]);
	});

	test("公式配布ページは既定ブラウザで開く", async () => {
		const mock = createRuntimeMock();
		await openExtensionInstallDestinationClient("store", mock.runtime, chromeStoreUrl);

		expect(mock.openedUrls).toEqual([chromeStoreUrl]);
	});

	test("配布先未設定・resource解決失敗・URLを開けない場合を構造化エラーにする", async () => {
		const resolveFailure = createRuntimeMock({ resolveError: true });
		await expect(
			openExtensionInstallDestinationClient("store", resolveFailure.runtime),
		).rejects.toMatchObject({ code: "DESTINATION_UNAVAILABLE" });
		await expect(
			openExtensionInstallDestinationClient("bundled", resolveFailure.runtime),
		).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });

		const openFailure = createRuntimeMock({ openError: true });
		await expect(
			openExtensionInstallDestinationClient("store", openFailure.runtime, chromeStoreUrl),
		).rejects.toBeInstanceOf(ExtensionInstallError);
	});
});

describe("SQLite-backed extension setup status", () => {
	const readyStatus = {
		state: "ready",
		observation: {
			installationId: "550e8400-e29b-41d4-a716-446655440000",
			extensionVersion: "0.1.0",
			protocolVersion: 1,
			firstSeenAt: "2026-07-20T12:00:00.000Z",
			lastSeenAt: "2026-07-20T12:01:00.000Z",
		},
	} as const;

	test("Tauri応答を厳密に検証する", () => {
		expect(parseExtensionSetupStatus(readyStatus)).toEqual(readyStatus);
		expect(parseExtensionSetupStatus({ state: "waiting", observation: null })).toEqual({
			state: "waiting",
			observation: null,
		});
		expect(parseExtensionSetupStatus({ state: "ready", observation: null })).toBeNull();
		expect(
			parseExtensionSetupStatus({
				...readyStatus,
				observation: { ...readyStatus.observation, lastSeenAt: "invalid" },
			}),
		).toBeNull();
	});

	test("確認開始日時をTauriへ渡し、SQLite由来の応答だけで完了する", async () => {
		const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
		const runtime: ExtensionStatusRuntime = {
			invoke: async (command, args) => {
				calls.push({ command, args });
				return readyStatus;
			},
		};
		const since = "2026-07-20T12:00:30.000Z";

		await expect(getExtensionSetupStatusClient(since, runtime)).resolves.toEqual(readyStatus);
		expect(calls).toEqual([
			{
				command: "get_extension_setup_status",
				args: { since },
			},
		]);
	});

	test("プレビューでは完了を偽装せず待機状態にする", async () => {
		await expect(getExtensionSetupStatusClient("2026-07-20T12:00:00.000Z", null)).resolves.toEqual({
			state: "waiting",
			observation: null,
		});
	});

	test("不正日時と壊れたTauri応答をエラーにする", async () => {
		await expect(getExtensionSetupStatusClient("invalid", null)).rejects.toMatchObject({
			code: "STATUS_UNAVAILABLE",
		});
		const runtime: ExtensionStatusRuntime = {
			invoke: async () => ({ state: "ready", observation: null }),
		};
		await expect(
			getExtensionSetupStatusClient("2026-07-20T12:00:00.000Z", runtime),
		).rejects.toMatchObject({ code: "STATUS_UNAVAILABLE" });
	});
});
