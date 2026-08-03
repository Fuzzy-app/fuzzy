import type { ExtensionRuntimeObservation, ExtensionSetupStatus } from "@fuzzy/shared";
import distributionConfig from "../../../distribution.config.json";

export type ExtensionInstallChannel = "bundled" | "store";

export type ExtensionInstallTarget =
	| { kind: "bundled-resource"; value: string }
	| { kind: "store-url"; value: string };

export type ExtensionInstallDestination = {
	available: boolean;
	kind: ExtensionInstallChannel;
	label: string;
	displayTarget: string | null;
	target: ExtensionInstallTarget | null;
	reason: string | null;
};

export type ExtensionInstallOpenResult = {
	destination: ExtensionInstallDestination;
	mocked: boolean;
	openedTarget: string | null;
};

export type ExtensionInstallRuntime = {
	resolveResource: (resourcePath: string) => Promise<string>;
	revealItemInDir: (path: string) => Promise<void>;
	openUrl: (url: string) => Promise<void>;
};

export type ExtensionStatusRuntime = {
	invoke: <T>(command: string, args: Record<string, unknown>) => Promise<T>;
};

export type NativeHostInstallationStatus = {
	ready: boolean;
	message: string;
};

export type ExtensionInstallErrorCode =
	| "DESTINATION_UNAVAILABLE"
	| "RESOURCE_UNAVAILABLE"
	| "OPEN_FAILED"
	| "STATUS_UNAVAILABLE";

export class ExtensionInstallError extends Error {
	constructor(
		public readonly code: ExtensionInstallErrorCode,
		message: string,
	) {
		super(message);
		this.name = "ExtensionInstallError";
	}
}

const bundledManifestResourcePath = "resources/extension/chrome-mv3/manifest.json";
const allowedExtensionIds = new Set(distributionConfig.extensionIds);

// 公式配布開始後は、利用する1つの配布ページを設定する。
// ブラウザの種類は判定せず、既定ブラウザでページを開く。
const configuredExtensionStoreUrl: unknown = (distributionConfig as { extensionStoreUrl?: unknown })
	.extensionStoreUrl;
export const extensionStoreUrl: string | null =
	typeof configuredExtensionStoreUrl === "string" ? configuredExtensionStoreUrl : null;

export function isTauriRuntime(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Fuzzyの拡張機能詳細ページだけを許可する。
 * ストアのトップページや任意パスを配布先として受け入れない。
 */
export function isAllowedExtensionStoreUrl(value: string | null): value is string {
	if (!value) return false;

	try {
		const url = new URL(value);
		if (url.protocol !== "https:") return false;

		const segments = url.pathname.split("/").filter(Boolean);
		const extensionId = segments.at(-1) ?? "";
		const hasValidExtensionId =
			/^[a-p]{32}$/.test(extensionId) && allowedExtensionIds.has(extensionId);

		if (url.hostname === "chromewebstore.google.com") {
			return segments.length === 3 && segments[0] === "detail" && hasValidExtensionId;
		}
		if (url.hostname === "microsoftedge.microsoft.com") {
			return (
				segments.length === 4 &&
				segments[0] === "addons" &&
				segments[1] === "detail" &&
				hasValidExtensionId
			);
		}
		return false;
	} catch {
		return false;
	}
}

export function getPreferredExtensionInstallChannel(
	storeUrl: string | null = extensionStoreUrl,
): ExtensionInstallChannel {
	return isAllowedExtensionStoreUrl(storeUrl) ? "store" : "bundled";
}

export function getExtensionInstallDestination(
	channel: ExtensionInstallChannel,
	storeUrl: string | null = extensionStoreUrl,
): ExtensionInstallDestination {
	if (channel === "store") {
		const allowedStoreUrl = isAllowedExtensionStoreUrl(storeUrl) ? storeUrl : null;
		return {
			available: allowedStoreUrl !== null,
			kind: channel,
			label: "Fuzzy公式配布ページ",
			displayTarget: allowedStoreUrl,
			target: allowedStoreUrl ? { kind: "store-url", value: allowedStoreUrl } : null,
			reason:
				allowedStoreUrl !== null
					? null
					: storeUrl === null
						? "公式配布ページはまだ設定されていません。"
						: "公式配布ページのURLが安全な拡張機能詳細ページではありません。",
		};
	}

	return {
		available: true,
		kind: channel,
		label: "Fuzzy拡張機能を追加",
		displayTarget: "Fuzzyアプリ内の拡張機能フォルダー",
		target: {
			kind: "bundled-resource",
			value: bundledManifestResourcePath,
		},
		reason: null,
	};
}

async function createRuntimeInstaller(): Promise<ExtensionInstallRuntime | null> {
	if (!isTauriRuntime()) return null;

	const [{ resolveResource }, { openUrl, revealItemInDir }] = await Promise.all([
		import("@tauri-apps/api/path"),
		import("@tauri-apps/plugin-opener"),
	]);
	return { resolveResource, revealItemInDir, openUrl };
}

export async function openExtensionInstallDestinationClient(
	channel: ExtensionInstallChannel,
	runtime?: ExtensionInstallRuntime | null,
	storeUrl: string | null = extensionStoreUrl,
): Promise<ExtensionInstallOpenResult> {
	const destination = getExtensionInstallDestination(channel, storeUrl);
	if (!destination.available || !destination.target) {
		throw new ExtensionInstallError(
			"DESTINATION_UNAVAILABLE",
			destination.reason ?? "拡張機能の導入先を利用できません。",
		);
	}

	const installer = runtime === undefined ? await createRuntimeInstaller() : runtime;
	if (!installer) {
		return {
			destination,
			mocked: true,
			openedTarget: destination.displayTarget,
		};
	}

	if (destination.target.kind === "bundled-resource") {
		try {
			const manifestPath = await installer.resolveResource(destination.target.value);
			await installer.revealItemInDir(manifestPath);
			return { destination, mocked: false, openedTarget: manifestPath };
		} catch {
			throw new ExtensionInstallError(
				"RESOURCE_UNAVAILABLE",
				"Fuzzy拡張機能のフォルダーを表示できませんでした。Fuzzyを再起動してから再試行してください。",
			);
		}
	}

	try {
		await installer.openUrl(destination.target.value);
		return {
			destination,
			mocked: false,
			openedTarget: destination.target.value,
		};
	} catch {
		throw new ExtensionInstallError(
			"OPEN_FAILED",
			"公式配布ページを既定のブラウザで開けませんでした。ブラウザを起動してから再試行してください。",
		);
	}
}

export async function createStatusRuntime(): Promise<ExtensionStatusRuntime | null> {
	if (!isTauriRuntime()) return null;
	const { invoke } = await import("@tauri-apps/api/core");
	return { invoke };
}

export function parseExtensionSetupStatus(value: unknown): ExtensionSetupStatus | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;

	if (candidate.state === "waiting") {
		return candidate.observation === null ? { state: "waiting", observation: null } : null;
	}
	if (candidate.state !== "ready" && candidate.state !== "incompatible") return null;
	const observation = parseExtensionRuntimeObservation(candidate.observation);
	if (!observation) return null;

	return {
		state: candidate.state,
		observation,
	};
}

export function parseExtensionRuntimeObservation(
	value: unknown,
): ExtensionRuntimeObservation | null {
	if (!value || typeof value !== "object") return null;
	const observation = value as Record<string, unknown>;
	if (
		typeof observation.installationId !== "string" ||
		!/^[A-Za-z0-9-]{1,128}$/.test(observation.installationId) ||
		typeof observation.extensionVersion !== "string" ||
		!/^[A-Za-z0-9.+-]{1,64}$/.test(observation.extensionVersion) ||
		typeof observation.protocolVersion !== "number" ||
		!Number.isInteger(observation.protocolVersion) ||
		observation.protocolVersion <= 0 ||
		typeof observation.firstSeenAt !== "string" ||
		Number.isNaN(Date.parse(observation.firstSeenAt)) ||
		typeof observation.lastSeenAt !== "string" ||
		Number.isNaN(Date.parse(observation.lastSeenAt))
	) {
		return null;
	}

	return {
		installationId: observation.installationId,
		extensionVersion: observation.extensionVersion,
		protocolVersion: observation.protocolVersion,
		firstSeenAt: observation.firstSeenAt,
		lastSeenAt: observation.lastSeenAt,
	};
}

export async function getExtensionSetupStatusClient(
	since: string,
	runtime?: ExtensionStatusRuntime | null,
): Promise<ExtensionSetupStatus> {
	if (Number.isNaN(Date.parse(since))) {
		throw new ExtensionInstallError("STATUS_UNAVAILABLE", "確認開始日時が不正です。");
	}

	const statusRuntime = runtime === undefined ? await createStatusRuntime() : runtime;
	if (!statusRuntime) {
		return { state: "waiting", observation: null };
	}

	try {
		const value = await statusRuntime.invoke<unknown>("get_extension_setup_status", {
			since,
		});
		const status = parseExtensionSetupStatus(value);
		if (!status) {
			throw new Error("invalid response");
		}
		return status;
	} catch {
		throw new ExtensionInstallError(
			"STATUS_UNAVAILABLE",
			"拡張機能の状態を読み込めませんでした。Fuzzyを再起動してから再試行してください。",
		);
	}
}

export function parseNativeHostInstallationStatus(
	value: unknown,
): NativeHostInstallationStatus | null {
	if (!value || typeof value !== "object") return null;
	const status = value as Record<string, unknown>;
	if (typeof status.ready !== "boolean" || typeof status.message !== "string") {
		return null;
	}
	return {
		ready: status.ready,
		message: status.message,
	};
}

async function invokeNativeHostInstallationCommand(
	command: "get_native_host_installation_status" | "repair_native_host_installation",
	runtime?: ExtensionStatusRuntime | null,
): Promise<NativeHostInstallationStatus> {
	const statusRuntime = runtime === undefined ? await createStatusRuntime() : runtime;
	if (!statusRuntime) {
		return {
			ready: false,
			message:
				"このプレビューでは拡張機能との接続を準備しません。Fuzzyのデスクトップアプリで確認してください。",
		};
	}
	try {
		const value = await statusRuntime.invoke<unknown>(command, {});
		const status = parseNativeHostInstallationStatus(value);
		if (!status) throw new Error("invalid response");
		return status;
	} catch {
		throw new ExtensionInstallError(
			"STATUS_UNAVAILABLE",
			"拡張機能との接続状態を確認できませんでした。Fuzzyを再起動してから再試行してください。",
		);
	}
}

export function getNativeHostInstallationStatusClient(
	runtime?: ExtensionStatusRuntime | null,
): Promise<NativeHostInstallationStatus> {
	return invokeNativeHostInstallationCommand("get_native_host_installation_status", runtime);
}

export function repairNativeHostInstallationClient(
	runtime?: ExtensionStatusRuntime | null,
): Promise<NativeHostInstallationStatus> {
	return invokeNativeHostInstallationCommand("repair_native_host_installation", runtime);
}
