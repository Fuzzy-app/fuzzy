import { readdir, rm, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
	extensionBundleDirectory,
	validatePreparedExtensionBundle,
} from "./prepare-extension";
import { validateDistributionVersions } from "./distribution-version";

const desktopDirectory = resolve(import.meta.dir, "..");
const extensionDirectory = resolve(desktopDirectory, "..", "extension");
const extensionOutputDirectory = resolve(extensionDirectory, ".output");

async function validateArchiveTree(directory: string): Promise<void> {
	const entries = await readdir(directory, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isDirectory()) {
			await validateArchiveTree(resolve(directory, entry.name));
		} else if (!entry.isFile()) {
			throw new Error(`拡張機能の成果物にリンクまたは特殊ファイルがあります: ${entry.name}`);
		}
	}
}

async function topLevelEntries(): Promise<string[]> {
	const entries = await readdir(extensionBundleDirectory, { withFileTypes: true });
	if (entries.length === 0) {
		throw new Error("ZIP化する拡張機能の成果物が空です。");
	}
	await validateArchiveTree(extensionBundleDirectory);
	return entries.map((entry) => entry.name).sort();
}

async function runTar(arguments_: string[]): Promise<string> {
	const process = Bun.spawn(["tar.exe", ...arguments_], {
		cwd: extensionDirectory,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`拡張機能ZIPを作成できませんでした: ${stderr.trim()}`);
	}
	return stdout;
}

export async function packagePreparedExtension(): Promise<string> {
	if (process.platform !== "win32") {
		throw new Error("Windows配布用の拡張機能ZIPはWindows上で作成してください。");
	}
	await validatePreparedExtensionBundle();
	const extensionVersion = await validateDistributionVersions();

	const archivePath = resolve(
		extensionOutputDirectory,
		`fuzzyextension-${extensionVersion}-chrome.zip`,
	);
	await rm(archivePath, { force: true });
	const entries = await topLevelEntries();
	await runTar([
		"-a",
		"-c",
		"-f",
		archivePath,
		"-C",
		extensionBundleDirectory,
		...entries,
	]);

	const archive = await stat(archivePath);
	if (!archive.isFile() || archive.size === 0) {
		throw new Error("作成した拡張機能ZIPが空です。");
	}
	const listing = (await runTar(["-t", "-f", archivePath]))
		.split(/\r?\n/)
		.map((entry) => entry.replaceAll("\\", "/").replace(/^\.\//, ""))
		.filter(Boolean);
	if (!listing.includes("manifest.json")) {
		throw new Error("作成した拡張機能ZIPにmanifest.jsonがありません。");
	}
	console.log(`同梱版と同じ拡張機能をZIP化しました: ${basename(archivePath)}`);
	return archivePath;
}

if (import.meta.main) {
	try {
		await packagePreparedExtension();
	} catch (error) {
		console.error(error instanceof Error ? error.message : "拡張機能ZIPの作成に失敗しました。");
		process.exit(1);
	}
}
