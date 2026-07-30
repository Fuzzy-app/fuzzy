import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
	DESKTOP_ICON_FILENAMES,
	OFFICIAL_ICON_RELATIVE_PATH,
} from "../../apps/desktop/scripts/generate-brand-icons";

async function sha256(path: string): Promise<string> {
	const bytes = await Bun.file(path).arrayBuffer();
	return createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
}

describe("desktop brand assets", () => {
	test("公式SVGを画面とデスクトップアイコン生成の共通原本にする", async () => {
		const desktopDirectory = resolve(import.meta.dir, "..", "..", "apps", "desktop");
		const officialIconPath = resolve(desktopDirectory, OFFICIAL_ICON_RELATIVE_PATH);
		const pageSource = await Bun.file(
			resolve(desktopDirectory, "src", "routes", "+page.svelte"),
		).text();
		const packageJson = await Bun.file(resolve(desktopDirectory, "package.json")).json();

		expect(await Bun.file(officialIconPath).exists()).toBe(true);
		expect(pageSource).toContain(
			'import fuzzyIconUrl from "../../../extension/public/icon/fuzzy.svg?url"',
		);
		expect(packageJson.scripts["generate:icons"]).toBe("bun run scripts/generate-brand-icons.ts");
		expect(DESKTOP_ICON_FILENAMES).toContain("icon.ico");
		expect(DESKTOP_ICON_FILENAMES).toContain("icon.icns");
	});

	test("faviconとウィンドウ用32pxアイコンを同じ生成物にする", async () => {
		const desktopDirectory = resolve(import.meta.dir, "..", "..", "apps", "desktop");
		const faviconPath = resolve(desktopDirectory, "static", "favicon.png");
		const windowIconPath = resolve(desktopDirectory, "src-tauri", "icons", "32x32.png");

		expect(await sha256(faviconPath)).toBe(await sha256(windowIconPath));
	});
});
