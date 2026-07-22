import type { ExtensionSetupStatus } from "@fuzzy/shared";

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

const bundledManifestResourcePath = "extension/chrome-mv3/manifest.json";

// 公式配布開始後は、利用する1つの配布ページを設定する。
// ブラウザの種類は判定せず、既定ブラウザでページを開く。
export const extensionStoreUrl: string | null = null;

function isTauriRuntime(): boolean {
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
		const hasValidExtensionId = /^[a-p]{32}$/.test(extensionId);

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
		label: "Fuzzyアプリ同梱版",
		displayTarget: "Fuzzyアプリに同梱済み",
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
				"同梱された拡張機能フォルダーを表示できませんでした。Fuzzyを再起動してから再試行してください。",
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

async function createStatusRuntime(): Promise<ExtensionStatusRuntime | null> {
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
	if (!candidate.observation || typeof candidate.observation !== "object") return null;

	const observation = candidate.observation as Record<string, unknown>;
	if (
		typeof observation.installationId !== "string" ||
		typeof observation.extensionVersion !== "string" ||
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
		state: candidate.state,
		observation: {
			installationId: observation.installationId,
			extensionVersion: observation.extensionVersion,
			protocolVersion: observation.protocolVersion,
			firstSeenAt: observation.firstSeenAt,
			lastSeenAt: observation.lastSeenAt,
		},
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
			"SQLiteから拡張機能の応答情報を読み込めませんでした。Fuzzyを再起動してから再試行してください。",
		);
	}
}
