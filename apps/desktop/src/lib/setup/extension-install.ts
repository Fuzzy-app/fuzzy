export type SupportedBrowserId = "chrome" | "edge";

export type BrowserChoice = SupportedBrowserId | "unsupported";

export type ExtensionInstallChannel = "bundled" | "store";

export type ExtensionInstallStatus = "not-started" | "destination-opened" | "confirmed";

export type ExtensionStoreUrls = Readonly<Record<SupportedBrowserId, string | null>>;

export type SupportedBrowserOption = {
	id: SupportedBrowserId;
	name: string;
	shortName: string;
	description: string;
	managementUrl: string;
	bundledManifestResourcePath: string;
	storeUrl: string | null;
	storeApplication: string;
};

export type ExtensionInstallState = {
	browserId: BrowserChoice;
	channel: ExtensionInstallChannel;
	status: ExtensionInstallStatus;
	lastOpenedAt?: string;
	completedAt?: string;
	updatedAt: string;
};

export type ExtensionInstallStateInput = Omit<ExtensionInstallState, "updatedAt">;

export type ExtensionInstallTarget =
	| { kind: "bundled-resource"; value: string }
	| { kind: "store-url"; value: string; openWith: string };

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
	openUrl: (url: string, openWith?: string) => Promise<void>;
};

export type ExtensionInstallErrorCode =
	| "UNSUPPORTED_BROWSER"
	| "DESTINATION_UNAVAILABLE"
	| "RESOURCE_UNAVAILABLE"
	| "OPEN_FAILED";

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

// 公式ストア公開後はURLを設定するだけで、未完了の新規導入がstore優先へ切り替わる。
export const extensionStoreUrls: ExtensionStoreUrls = {
	chrome: null,
	edge: null,
};

const storeHosts: Readonly<Record<SupportedBrowserId, string>> = {
	chrome: "chromewebstore.google.com",
	edge: "microsoftedge.microsoft.com",
};

export function createSupportedBrowserOptions(
	storeUrls: ExtensionStoreUrls = extensionStoreUrls,
): readonly SupportedBrowserOption[] {
	return [
		{
			id: "chrome",
			name: "Google Chrome",
			shortName: "Chrome",
			description: "MoodleをGoogle Chromeで利用する場合に選択します。",
			managementUrl: "chrome://extensions",
			bundledManifestResourcePath,
			storeUrl: storeUrls.chrome,
			storeApplication: "chrome.exe",
		},
		{
			id: "edge",
			name: "Microsoft Edge",
			shortName: "Edge",
			description: "MoodleをMicrosoft Edgeで利用する場合に選択します。",
			managementUrl: "edge://extensions",
			bundledManifestResourcePath,
			storeUrl: storeUrls.edge,
			storeApplication: "msedge.exe",
		},
	] as const;
}

export const supportedBrowserOptions = createSupportedBrowserOptions();

const extensionInstallStorageKey = "fuzzy.desktop.extensionInstall";
const installStatuses: readonly ExtensionInstallStatus[] = [
	"not-started",
	"destination-opened",
	"confirmed",
];
const installChannels: readonly ExtensionInstallChannel[] = ["bundled", "store"];

let memoryInstallState: ExtensionInstallState | null = null;

function canUseLocalStorage(): boolean {
	return typeof localStorage !== "undefined";
}

function isBrowserChoice(value: unknown): value is BrowserChoice {
	return value === "chrome" || value === "edge" || value === "unsupported";
}

function isInstallChannel(value: unknown): value is ExtensionInstallChannel {
	return installChannels.includes(value as ExtensionInstallChannel);
}

function isInstallStatus(value: unknown): value is ExtensionInstallStatus {
	return installStatuses.includes(value as ExtensionInstallStatus);
}

function isValidStoredDate(value: unknown): value is string {
	return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isValidOptionalStoredDate(value: unknown): value is string | undefined {
	return value === undefined || isValidStoredDate(value);
}

function isTauriRuntime(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function isAllowedStoreUrl(browserId: SupportedBrowserId, value: string | null): value is string {
	if (!value) {
		return false;
	}

	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.hostname === storeHosts[browserId];
	} catch {
		return false;
	}
}

async function createRuntimeInstaller(): Promise<ExtensionInstallRuntime | null> {
	if (!isTauriRuntime()) {
		return null;
	}

	const [{ resolveResource }, { openUrl, revealItemInDir }] = await Promise.all([
		import("@tauri-apps/api/path"),
		import("@tauri-apps/plugin-opener"),
	]);

	return { resolveResource, revealItemInDir, openUrl };
}

export function detectSupportedBrowser(userAgent: string): BrowserChoice {
	if (/Edg\//i.test(userAgent)) {
		return "edge";
	}

	if (/(?:Chrome|Chromium)\//i.test(userAgent)) {
		return "chrome";
	}

	return "unsupported";
}

export function getSupportedBrowserOption(
	browserId: BrowserChoice,
	options: readonly SupportedBrowserOption[] = supportedBrowserOptions,
): SupportedBrowserOption | null {
	return options.find(({ id }) => id === browserId) ?? null;
}

export function getPreferredExtensionInstallChannel(
	browserId: BrowserChoice,
	options: readonly SupportedBrowserOption[] = supportedBrowserOptions,
): ExtensionInstallChannel {
	const browser = getSupportedBrowserOption(browserId, options);

	return browser && isAllowedStoreUrl(browser.id, browser.storeUrl) ? "store" : "bundled";
}

export function getExtensionInstallChannelForState(
	state: ExtensionInstallState,
	options: readonly SupportedBrowserOption[] = supportedBrowserOptions,
): ExtensionInstallChannel {
	const currentDestination = getExtensionInstallDestination(
		state.browserId,
		state.channel,
		options,
	);

	// 確認済みの導入先は維持し、配布切替で同じ拡張機能の二重導入を強制しない。
	if (state.status === "confirmed" && currentDestination.available) {
		return state.channel;
	}

	return getPreferredExtensionInstallChannel(state.browserId, options);
}

export function createInitialExtensionInstallState(
	browserId: BrowserChoice,
): ExtensionInstallState {
	return {
		browserId,
		channel: getPreferredExtensionInstallChannel(browserId),
		status: "not-started",
		updatedAt: new Date(0).toISOString(),
	};
}

export function parseExtensionInstallState(value: unknown): ExtensionInstallState | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const candidate = value as Record<string, unknown>;
	const channel = candidate.channel === "development" ? "bundled" : candidate.channel;
	const wasSkipped = candidate.status === "skipped";
	const status = wasSkipped ? "not-started" : candidate.status;

	if (
		!isBrowserChoice(candidate.browserId) ||
		!isInstallChannel(channel) ||
		!isInstallStatus(status) ||
		!isValidStoredDate(candidate.updatedAt)
	) {
		return null;
	}

	if (
		!isValidOptionalStoredDate(candidate.lastOpenedAt) ||
		!isValidOptionalStoredDate(candidate.completedAt)
	) {
		return null;
	}

	return {
		browserId: candidate.browserId,
		channel,
		status,
		lastOpenedAt: wasSkipped ? undefined : candidate.lastOpenedAt,
		completedAt: wasSkipped ? undefined : candidate.completedAt,
		updatedAt: candidate.updatedAt,
	};
}

export function createDestinationOpenedStateInput(
	currentState: ExtensionInstallState,
	browserId: BrowserChoice,
	channel: ExtensionInstallChannel,
	openedAt: string,
): ExtensionInstallStateInput {
	const isConfirmed = currentState.status === "confirmed";

	return {
		browserId,
		channel,
		status: isConfirmed ? currentState.status : "destination-opened",
		lastOpenedAt: openedAt,
		completedAt: isConfirmed ? currentState.completedAt : undefined,
	};
}

export function isExtensionInstallStateForDestination(
	state: ExtensionInstallState,
	browserId: BrowserChoice,
	channel: ExtensionInstallChannel,
): boolean {
	return state.browserId === browserId && state.channel === channel;
}

export function getExtensionInstallDestination(
	browserId: BrowserChoice,
	channel: ExtensionInstallChannel,
	options: readonly SupportedBrowserOption[] = supportedBrowserOptions,
): ExtensionInstallDestination {
	const browser = getSupportedBrowserOption(browserId, options);

	if (!browser) {
		return {
			available: false,
			kind: channel,
			label: "未対応ブラウザ",
			displayTarget: null,
			target: null,
			reason: "Google Chrome または Microsoft Edge を選択してください。",
		};
	}

	if (channel === "store") {
		const storeUrl = isAllowedStoreUrl(browser.id, browser.storeUrl) ? browser.storeUrl : null;

		return {
			available: storeUrl !== null,
			kind: channel,
			label: `${browser.shortName} の公式ストア`,
			displayTarget: storeUrl,
			target: storeUrl
				? {
						kind: "store-url",
						value: storeUrl,
						openWith: browser.storeApplication,
					}
				: null,
			reason:
				storeUrl !== null
					? null
					: browser.storeUrl === null
						? "公式ストアの配布URLはまだ設定されていません。"
						: "公式ストアの配布URLが安全なURLではありません。",
		};
	}

	return {
		available: true,
		kind: channel,
		label: `${browser.shortName} 用の同梱版`,
		displayTarget: "Fuzzyアプリに同梱済み",
		target: {
			kind: "bundled-resource",
			value: browser.bundledManifestResourcePath,
		},
		reason: null,
	};
}

export async function openExtensionInstallDestinationClient(
	browserId: BrowserChoice,
	channel: ExtensionInstallChannel,
	runtime?: ExtensionInstallRuntime | null,
	options: readonly SupportedBrowserOption[] = supportedBrowserOptions,
): Promise<ExtensionInstallOpenResult> {
	const destination = getExtensionInstallDestination(browserId, channel, options);

	if (browserId === "unsupported") {
		throw new ExtensionInstallError(
			"UNSUPPORTED_BROWSER",
			destination.reason ?? "このブラウザには対応していません。",
		);
	}

	if (!destination.available || !destination.target) {
		throw new ExtensionInstallError(
			"DESTINATION_UNAVAILABLE",
			destination.reason ?? "導入先を利用できません。",
		);
	}

	const runtimeInstaller = runtime === undefined ? await createRuntimeInstaller() : runtime;

	if (!runtimeInstaller) {
		return {
			destination,
			mocked: true,
			openedTarget: destination.displayTarget,
		};
	}

	if (destination.target.kind === "bundled-resource") {
		try {
			const manifestPath = await runtimeInstaller.resolveResource(destination.target.value);
			await runtimeInstaller.revealItemInDir(manifestPath);

			return { destination, mocked: false, openedTarget: manifestPath };
		} catch {
			throw new ExtensionInstallError(
				"RESOURCE_UNAVAILABLE",
				"同梱された拡張機能フォルダーを表示できませんでした。Fuzzyを再起動してから再試行してください。",
			);
		}
	}

	try {
		await runtimeInstaller.openUrl(destination.target.value, destination.target.openWith);
	} catch {
		throw new ExtensionInstallError(
			"OPEN_FAILED",
			"選択したブラウザで公式ストアを開けませんでした。ブラウザを起動してから再試行してください。",
		);
	}

	return {
		destination,
		mocked: false,
		openedTarget: destination.target.value,
	};
}

export async function getExtensionInstallStateClient(
	fallbackBrowserId: BrowserChoice,
): Promise<ExtensionInstallState> {
	if (memoryInstallState) {
		return Promise.resolve(memoryInstallState);
	}

	if (!canUseLocalStorage()) {
		return Promise.resolve(createInitialExtensionInstallState(fallbackBrowserId));
	}

	const savedState = localStorage.getItem(extensionInstallStorageKey);

	if (!savedState) {
		return Promise.resolve(createInitialExtensionInstallState(fallbackBrowserId));
	}

	try {
		const parsedState = parseExtensionInstallState(JSON.parse(savedState));

		if (parsedState) {
			memoryInstallState = parsedState;
			return Promise.resolve(parsedState);
		}
	} catch {
		// 壊れたモック値は破棄し、初期状態から安全にやり直す。
	}

	localStorage.removeItem(extensionInstallStorageKey);

	return Promise.resolve(createInitialExtensionInstallState(fallbackBrowserId));
}

export async function saveExtensionInstallStateClient(
	input: ExtensionInstallStateInput,
): Promise<ExtensionInstallState> {
	const state: ExtensionInstallState = {
		...input,
		updatedAt: new Date().toISOString(),
	};

	memoryInstallState = state;

	if (canUseLocalStorage()) {
		localStorage.setItem(extensionInstallStorageKey, JSON.stringify(state));
	}

	return Promise.resolve(state);
}
