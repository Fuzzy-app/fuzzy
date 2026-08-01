import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const OFFICIAL_ICON_RELATIVE_PATH = "../extension/public/icon/fuzzy.svg";

export const DESKTOP_ICON_FILENAMES = [
	"32x32.png",
	"128x128.png",
	"128x128@2x.png",
	"icon.png",
	"icon.ico",
	"icon.icns",
	"Square30x30Logo.png",
	"Square44x44Logo.png",
	"Square71x71Logo.png",
	"Square89x89Logo.png",
	"Square107x107Logo.png",
	"Square142x142Logo.png",
	"Square150x150Logo.png",
	"Square284x284Logo.png",
	"Square310x310Logo.png",
	"StoreLogo.png",
] as const;

const desktopDirectory = resolve(import.meta.dir, "..");
const officialIconPath = resolve(desktopDirectory, OFFICIAL_ICON_RELATIVE_PATH);
const desktopIconsDirectory = resolve(desktopDirectory, "src-tauri", "icons");
const faviconPath = resolve(desktopDirectory, "static", "favicon.png");

async function assertGeneratedFile(path: string): Promise<void> {
	const generated = await stat(path);
	if (!generated.isFile() || generated.size === 0) {
		throw new Error(`生成した公式アイコンが空です: ${path}`);
	}
}

export async function generateDesktopBrandIcons(): Promise<void> {
	if (!(await Bun.file(officialIconPath).exists())) {
		throw new Error(`公式アイコンの原本を読み込めませんでした: ${officialIconPath}`);
	}

	const temporaryDirectory = await mkdtemp(join(tmpdir(), "fuzzy-desktop-icons-"));
	try {
		const process = Bun.spawn(
			["bun", "run", "tauri", "icon", officialIconPath, "--output", temporaryDirectory],
			{
				cwd: desktopDirectory,
				stdout: "inherit",
				stderr: "inherit",
			},
		);
		const exitCode = await process.exited;
		if (exitCode !== 0) {
			throw new Error(
				`デスクトップ用の公式アイコンを生成できませんでした（終了コード: ${exitCode}）。`,
			);
		}

		for (const fileName of DESKTOP_ICON_FILENAMES) {
			await assertGeneratedFile(resolve(temporaryDirectory, fileName));
		}
		for (const fileName of DESKTOP_ICON_FILENAMES) {
			await copyFile(
				resolve(temporaryDirectory, fileName),
				resolve(desktopIconsDirectory, fileName),
			);
		}
		await copyFile(resolve(temporaryDirectory, "32x32.png"), faviconPath);
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	try {
		await generateDesktopBrandIcons();
		console.log("デスクトップとfaviconへFuzzyの公式アイコンを反映しました。");
	} catch (error) {
		console.error(
			error instanceof Error
				? error.message
				: "デスクトップ用の公式アイコンを生成できませんでした。",
		);
		process.exit(1);
	}
}
