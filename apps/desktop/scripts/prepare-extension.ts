import { resolve } from "node:path";

type ExtensionManifest = {
	manifest_version?: unknown;
	permissions?: unknown;
	content_scripts?: unknown;
};

export const extensionProjectDirectory = resolve(import.meta.dir, "..", "..", "extension");
export const extensionBundleDirectory = resolve(extensionProjectDirectory, ".output", "chrome-mv3");

const requiredBundleFiles = [
	"manifest.json",
	"background.js",
	"popup.html",
	"content-scripts/content.js",
	"icon/128.png",
] as const;

export function validateExtensionManifest(value: unknown): void {
	if (!value || typeof value !== "object") {
		throw new Error("拡張機能のmanifest.jsonを読み取れませんでした。");
	}

	const manifest = value as ExtensionManifest;
	const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];

	if (manifest.manifest_version !== 3) {
		throw new Error("同梱対象はManifest V3の拡張機能である必要があります。");
	}

	if (!permissions.includes("nativeMessaging")) {
		throw new Error("同梱対象の拡張機能にnativeMessaging権限がありません。");
	}

	if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length === 0) {
		throw new Error("同梱対象の拡張機能にcontent scriptがありません。");
	}
}

async function buildExtension(): Promise<void> {
	const buildProcess = Bun.spawn(["bun", "run", "build"], {
		cwd: extensionProjectDirectory,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await buildProcess.exited;

	if (exitCode !== 0) {
		throw new Error(`拡張機能のビルドに失敗しました（終了コード: ${exitCode}）。`);
	}
}

async function validateBundleFiles(): Promise<void> {
	for (const relativePath of requiredBundleFiles) {
		const file = Bun.file(resolve(extensionBundleDirectory, relativePath));

		if (!(await file.exists())) {
			throw new Error(`拡張機能のビルド成果物が不足しています: ${relativePath}`);
		}
	}

	const manifest = await Bun.file(resolve(extensionBundleDirectory, "manifest.json")).json();
	validateExtensionManifest(manifest);
}

export async function prepareExtensionBundle(): Promise<void> {
	console.log("Fuzzyブラウザ拡張機能をTauri同梱用にビルドします。");
	await buildExtension();
	await validateBundleFiles();
	console.log(`同梱用の拡張機能を確認しました: ${extensionBundleDirectory}`);
}

if (import.meta.main) {
	try {
		await prepareExtensionBundle();
	} catch (error) {
		console.error(error instanceof Error ? error.message : "拡張機能の準備に失敗しました。");
		process.exit(1);
	}
}
