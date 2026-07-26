import { createHash } from "node:crypto";
import { resolve } from "node:path";

type ExtensionManifest = {
	key?: unknown;
	manifest_version?: unknown;
	permissions?: unknown;
	content_scripts?: unknown;
};

type DistributionConfig = {
	nativeHostName?: unknown;
	extensionIds?: unknown;
	extensionStoreUrl?: unknown;
};

type ValidatedDistributionConfig = {
	nativeHostName: string;
	extensionIds: string[];
	extensionStoreUrl: string | null;
};

export const extensionProjectDirectory = resolve(import.meta.dir, "..", "..", "extension");
export const extensionBundleDirectory = resolve(extensionProjectDirectory, ".output", "chrome-mv3");
const desktopProjectDirectory = resolve(import.meta.dir, "..");
const distributionConfigPath = resolve(desktopProjectDirectory, "distribution.config.json");
const nativeClientSourcePath = resolve(
	desktopProjectDirectory,
	"..",
	"..",
	"packages",
	"shared",
	"src",
	"api",
	"nativeClient.ts",
);

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

	if (typeof manifest.key !== "string" || !manifest.key) {
		throw new Error("同梱対象の拡張機能に固定ID用の公開鍵がありません。");
	}
}

export function deriveChromiumExtensionId(publicKeyBase64: string): string {
	const publicKey = Buffer.from(publicKeyBase64, "base64");
	if (publicKey.length === 0 || publicKey.toString("base64") !== publicKeyBase64) {
		throw new Error("拡張機能の公開鍵が正しいBase64ではありません。");
	}
	const digest = createHash("sha256").update(publicKey).digest().subarray(0, 16);
	return [...digest.toString("hex")]
		.map((character) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(character, 16)))
		.join("");
}

export async function validateDistributionConfiguration(): Promise<ValidatedDistributionConfig> {
	const config = (await Bun.file(distributionConfigPath).json()) as DistributionConfig;
	if (
		typeof config.nativeHostName !== "string" ||
		!Array.isArray(config.extensionIds) ||
		!config.extensionIds.every((id) => typeof id === "string") ||
		(config.extensionStoreUrl !== null && typeof config.extensionStoreUrl !== "string")
	) {
		throw new Error("desktopの配布設定が不正です。");
	}
	const validHostName =
		!config.nativeHostName.startsWith(".") &&
		!config.nativeHostName.endsWith(".") &&
		!config.nativeHostName.includes("..") &&
		/^[a-z0-9_.]+$/.test(config.nativeHostName);
	if (!validHostName) {
		throw new Error("desktopのNative Messagingホスト名が不正です。");
	}
	if (
		config.extensionIds.length === 0 ||
		config.extensionIds.some((id) => !/^[a-p]{32}$/.test(id)) ||
		new Set(config.extensionIds).size !== config.extensionIds.length
	) {
		throw new Error("desktopの拡張機能ID設定が不正です。");
	}
	const nativeClientSource = await Bun.file(nativeClientSourcePath).text();
	const configuredHostName = nativeClientSource.match(/const NATIVE_HOST_NAME = "([^"]+)"/)?.[1];
	if (configuredHostName !== config.nativeHostName) {
		throw new Error("NativeApiClientとdesktop配布設定のNative Messagingホスト名が一致しません。");
	}
	return {
		nativeHostName: config.nativeHostName,
		extensionIds: config.extensionIds,
		extensionStoreUrl: config.extensionStoreUrl,
	};
}

async function validateDistributionIdentity(manifest: ExtensionManifest): Promise<void> {
	const config = await validateDistributionConfiguration();
	const extensionId = deriveChromiumExtensionId(manifest.key as string);
	if (!config.extensionIds.includes(extensionId)) {
		throw new Error(
			`生成された拡張機能ID（${extensionId}）がNative Messagingの許可元にありません。`,
		);
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

export async function validatePreparedExtensionBundle(): Promise<void> {
	for (const relativePath of requiredBundleFiles) {
		const file = Bun.file(resolve(extensionBundleDirectory, relativePath));

		if (!(await file.exists())) {
			throw new Error(`拡張機能のビルド成果物が不足しています: ${relativePath}`);
		}
	}

	const manifest = (await Bun.file(
		resolve(extensionBundleDirectory, "manifest.json"),
	).json()) as ExtensionManifest;
	validateExtensionManifest(manifest);
	await validateDistributionIdentity(manifest);
}

export async function prepareExtensionBundle(): Promise<void> {
	console.log("Fuzzyブラウザ拡張機能をTauri同梱用にビルドします。");
	await buildExtension();
	await validatePreparedExtensionBundle();
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
