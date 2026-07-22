import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { validateExtensionManifest } from "../../apps/desktop/scripts/prepare-extension";
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

		expect(desktopPackage.scripts["dev:tauri"]).toContain("prepare:extension");
		expect(desktopPackage.scripts["build:tauri"]).toContain("prepare:extension");
		expect(tauriConfig.build.beforeDevCommand).toBe("bun run dev:tauri");
		expect(tauriConfig.build.beforeBuildCommand).toBe("bun run build:tauri");
		expect(tauriConfig.bundle.resources).toEqual({
			"../../extension/.output/chrome-mv3/": "extension/chrome-mv3/",
		});
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
		expect(storeConfig.bundle.resources).toBeNull();
		expect(() => validateExtensionStoreUrl(null)).toThrow(
			"同梱を外す前に公開URLを設定してください",
		);
		expect(() =>
			validateExtensionStoreUrl(
				"https://chromewebstore.google.com/detail/fuzzy/abcdefghijklmnopabcdefghijklmnop",
			),
		).not.toThrow();
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
		]);
	});

	test("Manifest V3・Native Messaging・content scriptを必須にする", () => {
		expect(() =>
			validateExtensionManifest({
				manifest_version: 3,
				permissions: ["nativeMessaging"],
				content_scripts: [{ matches: ["*://*.wakayama-u.ac.jp/*"] }],
			}),
		).not.toThrow();

		expect(() =>
			validateExtensionManifest({
				manifest_version: 2,
				permissions: [],
				content_scripts: [],
			}),
		).toThrow("Manifest V3");
	});
});
