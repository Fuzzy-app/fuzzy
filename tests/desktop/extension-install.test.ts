import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
	ExtensionInstallError,
	getExtensionInstallDestination,
	getExtensionSetupStatusClient,
	getNativeHostInstallationStatusClient,
	getPreferredExtensionInstallChannel,
	isAllowedExtensionStoreUrl,
	openExtensionInstallDestinationClient,
	parseExtensionSetupStatus,
	parseNativeHostInstallationStatus,
	repairNativeHostInstallationClient,
} from "../../apps/desktop/src/lib/setup/extension-install";
import type {
	ExtensionInstallRuntime,
	ExtensionStatusRuntime,
} from "../../apps/desktop/src/lib/setup/extension-install";
import {
	deriveExtensionRecoveryViewState,
	getExtensionRecoveryStatusClient,
	getMoodleRecoveryUrl,
	openMoodleForRecoveryClient,
	parseExtensionRecoveryStatus,
} from "../../apps/desktop/src/lib/setup/extension-recovery";

const extensionId = "edainabflfdaibonfpckomlaocmemagg";
const unregisteredExtensionId = "abcdefghijklmnopabcdefghijklmnop";
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
		expect(componentSource).toContain("拡張機能バージョンまたは通信仕様に互換性がありません");
		expect(componentSource).not.toContain("detectSupportedBrowser");
		expect(componentSource).not.toContain('type="checkbox"');
		expect(componentSource).not.toContain("今回はスキップ");
		expect(componentSource).not.toContain("localStorage");
	});

	test("復旧画面から資料・索引・バックアップをコマンドなしで保守できる", async () => {
		const componentSource = await Bun.file(
			resolve(import.meta.dir, "../../apps/desktop/src/lib/setup/ExtensionRecoveryPanel.svelte"),
		).text();

		expect(componentSource).toContain("保存先を再スキャンして検索索引を再構築");
		expect(componentSource).toContain("バックアップを書き出す");
		expect(componentSource).toContain("バックアップから復元");
		expect(componentSource).toContain("repairNativeHostInstallationClient");
		expect(componentSource).toContain("Native Messaging接続を自動修復");
		expect(componentSource).toContain("移動・削除せず");
		expect(componentSource).not.toContain("localStorage");
	});

	test("SQLiteを開けない起動時もGUI復旧でき、missing応答でも保守導線を隠さない", async () => {
		const startupRecoverySource = await Bun.file(
			resolve(import.meta.dir, "../../apps/desktop/src/lib/setup/StartupRecoveryPanel.svelte"),
		).text();
		const pageSource = await Bun.file(
			resolve(import.meta.dir, "../../apps/desktop/src/routes/+page.svelte"),
		).text();
		const rustSource = await Bun.file(
			resolve(import.meta.dir, "../../apps/desktop/src-tauri/src/lib.rs"),
		).text();

		expect(startupRecoverySource).toContain("バックアップから復元");
		expect(startupRecoverySource).toContain("破損DBを保全して新しく開始");
		expect(startupRecoverySource).toContain("検索索引を再構築");
		expect(startupRecoverySource).toContain("changeLibraryRootClient");
		expect(startupRecoverySource).toContain("バックアップ元の保存先がこのPCにない場合");
		expect(startupRecoverySource).toContain("保存先を変更");
		expect(startupRecoverySource).toContain("$: canChangeLibraryRoot = !databaseNeedsRecovery;");
		expect(startupRecoverySource).toContain("maintenanceError");
		expect(startupRecoverySource).toContain("資料は移動・削除しません");
		expect(pageSource).toContain("isRecoveryMode = setupStatus.done");
		expect(pageSource).not.toContain('status.state !== "missing"');
		expect(rustSource).not.toContain("Database::open_default().unwrap");
		expect(rustSource).not.toContain("DefaultIndexEngine::open_default().unwrap");
		expect(rustSource).toContain("保存先変更前に開けなかった検索索引を退避しました");
	});

	test("公開前は同梱版を既定にする", () => {
		expect(getPreferredExtensionInstallChannel()).toBe("bundled");
		expect(getExtensionInstallDestination("bundled")).toMatchObject({
			available: true,
			displayTarget: "Fuzzyアプリに同梱済み",
			target: {
				kind: "bundled-resource",
				value: "resources/extension/chrome-mv3/manifest.json",
			},
		});
	});

	test("ストアの拡張機能詳細ページだけを許可する", () => {
		expect(isAllowedExtensionStoreUrl(chromeStoreUrl)).toBe(true);
		expect(isAllowedExtensionStoreUrl(edgeStoreUrl)).toBe(true);
		expect(isAllowedExtensionStoreUrl("https://chromewebstore.google.com/")).toBe(false);
		expect(
			isAllowedExtensionStoreUrl(
				`https://chromewebstore.google.com/detail/fuzzy/${unregisteredExtensionId}`,
			),
		).toBe(false);
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
		expect(mock.resolvedResources).toEqual(["resources/extension/chrome-mv3/manifest.json"]);
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
			protocolVersion: 2,
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
		expect(
			parseExtensionSetupStatus({
				...readyStatus,
				observation: { ...readyStatus.observation, installationId: "../profile" },
			}),
		).toBeNull();
		expect(
			parseExtensionSetupStatus({
				...readyStatus,
				observation: { ...readyStatus.observation, extensionVersion: "0.1.0<script>" },
			}),
		).toBeNull();
	});

	test("確認開始日時をTauriへ渡し、SQLite由来の応答だけで完了する", async () => {
		const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
		const runtime: ExtensionStatusRuntime = {
			invoke: async <T>(command: string, args: Record<string, unknown>) => {
				calls.push({ command, args });
				return readyStatus as T;
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
			invoke: async <T>() => ({ state: "ready", observation: null }) as T,
		};
		await expect(
			getExtensionSetupStatusClient("2026-07-20T12:00:00.000Z", runtime),
		).rejects.toMatchObject({ code: "STATUS_UNAVAILABLE" });
	});
});

describe("Native Messaging host installation status", () => {
	test("Tauri応答を検証し、確認と自動修復のコマンドを呼び分ける", async () => {
		const calls: string[] = [];
		const runtime: ExtensionStatusRuntime = {
			invoke: async <T>(command: string) => {
				calls.push(command);
				return {
					ready: true,
					message: "Native Messagingホストを利用できます。",
				} as T;
			},
		};

		expect(
			parseNativeHostInstallationStatus({
				ready: true,
				message: "Native Messagingホストを利用できます。",
			}),
		).toEqual({
			ready: true,
			message: "Native Messagingホストを利用できます。",
		});
		expect(parseNativeHostInstallationStatus({ ready: "yes", message: "" })).toBeNull();
		await expect(getNativeHostInstallationStatusClient(runtime)).resolves.toMatchObject({
			ready: true,
		});
		await expect(repairNativeHostInstallationClient(runtime)).resolves.toMatchObject({
			ready: true,
		});
		expect(calls).toEqual([
			"get_native_host_installation_status",
			"repair_native_host_installation",
		]);
	});
});

describe("SQLite-backed extension recovery status", () => {
	const observation = {
		installationId: "550e8400-e29b-41d4-a716-446655440000",
		extensionVersion: "0.1.0",
		protocolVersion: 2,
		firstSeenAt: "2026-07-20T12:00:00.000Z",
		lastSeenAt: "2026-07-20T12:01:00.000Z",
	} as const;
	const readyStatus = {
		state: "ready",
		observation,
		recentWithinSeconds: 86_400,
	} as const;
	const staleStatus = { ...readyStatus, state: "stale" } as const;

	test("復旧状態のTauri応答を厳密に検証する", () => {
		expect(parseExtensionRecoveryStatus(readyStatus)).toEqual(readyStatus);
		expect(
			parseExtensionRecoveryStatus({
				state: "missing",
				observation: null,
				recentWithinSeconds: 86_400,
			}),
		).toEqual({
			state: "missing",
			observation: null,
			recentWithinSeconds: 86_400,
		});
		expect(
			parseExtensionRecoveryStatus({
				...readyStatus,
				recentWithinSeconds: 0,
			}),
		).toBeNull();
		expect(
			parseExtensionRecoveryStatus({
				...readyStatus,
				state: "missing",
			}),
		).toBeNull();
	});

	test("SQLiteの最新応答を取得するTauriコマンドだけを呼ぶ", async () => {
		const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
		const runtime: ExtensionStatusRuntime = {
			invoke: async <T>(command: string, args: Record<string, unknown>) => {
				calls.push({ command, args });
				return readyStatus as T;
			},
		};

		await expect(getExtensionRecoveryStatusClient(runtime)).resolves.toEqual(readyStatus);
		expect(calls).toEqual([{ command: "get_extension_recovery_status", args: {} }]);
	});

	test("応答あり・古い応答・再確認タイムアウトを区別する", () => {
		expect(deriveExtensionRecoveryViewState(readyStatus, null)).toBe("ready");
		expect(deriveExtensionRecoveryViewState(staleStatus, null)).toBe("stale");

		const startedAt = "2026-07-20T12:00:00.000Z";
		expect(
			deriveExtensionRecoveryViewState(
				staleStatus,
				startedAt,
				Date.parse("2026-07-20T12:00:10.000Z"),
				15_000,
			),
		).toBe("checking");
		expect(
			deriveExtensionRecoveryViewState(
				staleStatus,
				startedAt,
				Date.parse("2026-07-20T12:00:15.000Z"),
				15_000,
			),
		).toBe("timed-out");
	});

	test("互換性なし・更新後・再インストール後の新しい応答を反映する", () => {
		expect(deriveExtensionRecoveryViewState({ ...readyStatus, state: "incompatible" }, null)).toBe(
			"incompatible",
		);
		expect(
			deriveExtensionRecoveryViewState(
				{
					...readyStatus,
					observation: { ...observation, extensionVersion: "0.2.0" },
				},
				"2026-07-20T12:00:00.000Z",
			),
		).toBe("ready");
		expect(
			deriveExtensionRecoveryViewState(
				{
					...readyStatus,
					observation: {
						...observation,
						installationId: "replacement-installation",
					},
				},
				"2026-07-20T12:00:00.000Z",
			),
		).toBe("ready");
	});

	test("年度切替に依存しないMoodle URLをユーザー操作で既定ブラウザに開く", async () => {
		const openedUrls: string[] = [];
		expect(getMoodleRecoveryUrl()).toBe("https://moodle.wakayama-u.ac.jp/");
		await openMoodleForRecoveryClient({
			openUrl: async (url) => {
				openedUrls.push(url);
			},
		});
		expect(openedUrls).toEqual(["https://moodle.wakayama-u.ac.jp/"]);
		await expect(
			openMoodleForRecoveryClient({
				openUrl: async () => {
					throw new Error("failed");
				},
			}),
		).rejects.toMatchObject({ code: "OPEN_FAILED" });
	});

	test("復旧画面にブラウザ分岐・復旧状態の永続化を置かない", async () => {
		const componentSource = await Bun.file(
			resolve(import.meta.dir, "../../apps/desktop/src/lib/setup/ExtensionRecoveryPanel.svelte"),
		).text();
		const routeSource = await Bun.file(
			resolve(import.meta.dir, "../../apps/desktop/src/routes/+page.svelte"),
		).text();

		expect(componentSource).toContain("Moodleを開いて再確認");
		expect(componentSource).toContain("拡張機能の導入手順を開く");
		expect(componentSource).not.toContain("localStorage");
		expect(componentSource).not.toContain("IndexedDB");
		expect(componentSource).not.toContain("Chrome");
		expect(componentSource).not.toContain("Edge");
		expect(routeSource).toContain("extensionRecoveryLoadError");
		expect(routeSource).toContain("on:click={loadExtensionRecoveryStatus}");
		expect(routeSource).toContain("let isRecoveryMode = false;");
		expect(routeSource).toContain("isRecoveryMode = setupStatus.done");
		expect(routeSource).not.toContain('isRecoveryMode = status.state !== "missing"');
		expect(routeSource).not.toContain("$: isRecoveryMode = setupStatus.done");
	});
});
