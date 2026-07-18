import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { validateExtensionManifest } from "../../apps/desktop/scripts/prepare-extension";

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
