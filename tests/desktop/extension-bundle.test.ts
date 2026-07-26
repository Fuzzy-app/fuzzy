import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { isArtifactTimestampCurrent } from "../../apps/desktop/scripts/collect-windows-artifacts";
import { validateDistributionVersions } from "../../apps/desktop/scripts/distribution-version";
import {
	validateDistributionConfiguration,
	validateExtensionManifest,
} from "../../apps/desktop/scripts/prepare-extension";
import { validateExtensionStoreUrl } from "../../apps/desktop/scripts/validate-extension-store";

const repositoryRoot = resolve(import.meta.dir, "..", "..");

describe("Tauri extension bundle", () => {
	test("Tauri起動前に拡張機能をビルドして固定パスへ同梱する", async () => {
		const desktopPackage = await Bun.file(
			resolve(repositoryRoot, "apps/desktop/package.json"),
		).json();
		const tauriConfig = await Bun.file(
			resolve(repositoryRoot, "apps/desktop/src-tauri/tauri.conf.json"),
		).json();
		const desktopBuildScript = await Bun.file(
			resolve(repositoryRoot, "apps/desktop/src-tauri/build.rs"),
		).text();
		const distributionConfig = await Bun.file(
			resolve(repositoryRoot, "apps/desktop/distribution.config.json"),
		).json();

		expect(desktopPackage.scripts["dev:tauri"]).toContain("prepare:extension");
		expect(desktopPackage.scripts["build:tauri"]).toContain("prepare:extension");
		expect(desktopPackage.scripts["package:extension"]).toBe(
			"bun run scripts/package-extension.ts",
		);
		expect(tauriConfig.build.beforeDevCommand).toBe("bun run dev:tauri");
		expect(tauriConfig.build.beforeBuildCommand).toBe("bun run build:tauri");
		expect(tauriConfig.bundle.resources).toEqual({
			"../../extension/.output/chrome-mv3/": "resources/extension/chrome-mv3/",
			"resources/": "resources/",
		});
		expect(desktopBuildScript).toContain("create_dir_all");
		expect(desktopBuildScript).toContain("extension/.output/chrome-mv3");
		expect(distributionConfig.extensionStoreUrl).toBeNull();
	});

	test("審査用ZIPはインストーラー同梱後の同じバンドルを再ビルドせず使用する", async () => {
		const packageScript = await Bun.file(
			resolve(repositoryRoot, "apps/desktop/scripts/package-extension.ts"),
		).text();

		expect(packageScript).toContain("validatePreparedExtensionBundle");
		expect(packageScript).toContain('"-C"');
		expect(packageScript).toContain("extensionBundleDirectory");
		expect(packageScript).toContain('listing.includes("manifest.json")');
		expect(packageScript).not.toContain("wxt zip");
		expect(packageScript).not.toContain("prepareExtensionBundle()");
	});

	test("ストア公開後のビルドでは拡張機能成果物を同梱しない", async () => {
		const desktopPackage = await Bun.file(
			resolve(repositoryRoot, "apps/desktop/package.json"),
		).json();
		const storeConfig = await Bun.file(
			resolve(repositoryRoot, "apps/desktop/src-tauri/tauri.store.conf.json"),
		).json();

		expect(desktopPackage.scripts["tauri:build:store"]).toContain("tauri.store.conf.json");
		expect(desktopPackage.scripts["build:tauri:store"]).not.toContain("prepare:extension");
		expect(desktopPackage.scripts["build:tauri:store"]).toContain("validate:extension-store");
		expect(storeConfig.build.beforeBuildCommand).toBe("bun run build:tauri:store");
		expect(storeConfig.bundle.resources).toEqual({
			"../../extension/.output/chrome-mv3/": null,
			"resources/": "resources/",
		});
		expect(() => validateExtensionStoreUrl(null)).toThrow(
			"同梱を外す前に公開URLを設定してください",
		);
		expect(() =>
			validateExtensionStoreUrl(
				"https://chromewebstore.google.com/detail/fuzzy/edainabflfdaibonfpckomlaocmemagg",
			),
		).not.toThrow();
		expect(() =>
			validateExtensionStoreUrl(
				"https://chromewebstore.google.com/detail/fuzzy/abcdefghijklmnopabcdefghijklmnop",
			),
		).toThrow("拡張機能詳細ページ");
	});

	test("公式配布ページは許可したストアURLだけを既定ブラウザで開く", async () => {
		const capability = await Bun.file(
			resolve(repositoryRoot, "apps/desktop/src-tauri/capabilities/default.json"),
		).json();
		const storePermission = capability.permissions.find(
			(permission: unknown) =>
				typeof permission === "object" &&
				permission !== null &&
				"identifier" in permission &&
				permission.identifier === "opener:allow-open-url",
		);

		expect(capability.permissions).toContain("opener:allow-reveal-item-in-dir");
		expect(capability.permissions).not.toContain("opener:default");
		expect(storePermission.allow).toEqual([
			{
				url: "https://chromewebstore.google.com/*",
			},
			{
				url: "https://microsoftedge.microsoft.com/addons/*",
			},
			{
				url: "https://moodle*.wakayama-u.ac.jp/*",
			},
		]);
	});

	test("Manifest V3・Native Messaging・content scriptを必須にする", () => {
		expect(() =>
			validateExtensionManifest({
				key: "AQ==",
				manifest_version: 3,
				permissions: ["nativeMessaging"],
				content_scripts: [{ matches: ["*://*.wakayama-u.ac.jp/*"] }],
			}),
		).not.toThrow();

		expect(() =>
			validateExtensionManifest({
				key: "AQ==",
				manifest_version: 2,
				permissions: [],
				content_scripts: [],
			}),
		).toThrow("Manifest V3");
		expect(() =>
			validateExtensionManifest({
				manifest_version: 3,
				permissions: ["nativeMessaging"],
				content_scripts: [{ matches: ["*://*.wakayama-u.ac.jp/*"] }],
			}),
		).toThrow("固定ID用の公開鍵");
	});

	test("ストア版でもNative Messaging配布設定を独立して検証する", async () => {
		await expect(validateDistributionConfiguration()).resolves.toMatchObject({
			nativeHostName: "jp.ac.wakayama_u.fuzzy.native_host",
			extensionIds: ["edainabflfdaibonfpckomlaocmemagg"],
			extensionStoreUrl: null,
		});
		const validator = await Bun.file(
			resolve(repositoryRoot, "apps/desktop/scripts/validate-extension-store.ts"),
		).text();
		expect(validator).toContain("validateDistributionConfiguration");
	});

	test("配布対象すべてのバージョンが一致する", async () => {
		await expect(validateDistributionVersions()).resolves.toBe("0.1.0");
	});

	test("インストールと削除はホスト登録を自動化し、保存処理を強制終了しない", async () => {
		const hooks = await Bun.file(
			resolve(repositoryRoot, "apps/desktop/src-tauri/windows/installer-hooks.nsh"),
		).text();

		expect(hooks).toContain("--register-native-host");
		expect(hooks).toContain("--unregister-native-host");
		expect(hooks).not.toContain("taskkill");
		expect(hooks).not.toContain("/F");
	});

	test("一般向けインストーラーとQA用成果物を分離し、古い成果物を採用しない", async () => {
		const collector = await Bun.file(
			resolve(repositoryRoot, "apps/desktop/scripts/collect-windows-artifacts.ts"),
		).text();

		expect(collector).toContain('"QA-確認用"');
		expect(collector).toContain('resolve(stagingDirectory, "Fuzzy-Setup.exe")');
		expect(collector).toContain('resolve(qaDirectory, "FuzzyNativeHost.exe")');
		expect(collector).toContain('resolve(qaDirectory, "Fuzzy-Extension.zip")');
		expect(collector).not.toContain("assertNotOlder(installer, desktopExecutable");
		expect(collector).toContain("assertNotOlder(installer, nativeHost");
		expect(collector).toContain("assertNotOlder(installer, bundledExtensionFile");
		expect(collector).toContain("assertNotOlder(");
		expect(collector).toContain("publishStagedDirectory");
		expect(collector).toContain("assertPathWithin");
		expect(collector).not.toContain("newestMatchingFile");
		expect(collector).not.toContain('resolve(outputDirectory, "native-host.exe")');
	});

	test("成果物時刻はビルドツールの粒度差だけを許容する", () => {
		expect(isArtifactTimestampCurrent(10_000, 11_999)).toBe(true);
		expect(isArtifactTimestampCurrent(10_000, 12_001)).toBe(false);
	});
});
