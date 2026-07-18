export type SupportedBrowserId = "chrome" | "edge";

export type BrowserChoice = SupportedBrowserId | "unsupported";

export type ExtensionInstallChannel = "development" | "store";

export type ExtensionInstallStatus = "not-started" | "destination-opened" | "confirmed";

export type SupportedBrowserOption = {
	id: SupportedBrowserId;
	name: string;
	shortName: string;
	description: string;
	managementUrl: string;
	developmentOutputPath: string;
	developmentGuideUrl: string;
	storeUrl: string | null;
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

export type ExtensionInstallDestination = {
	available: boolean;
	kind: ExtensionInstallChannel;
	label: string;
	displayTarget: string | null;
	openTarget: string | null;
	reason: string | null;
};

export type ExtensionInstallOpenResult = {
	destination: ExtensionInstallDestination;
	mocked: boolean;
};

export type ExtensionInstallOpener = {
	openUrl: (url: string) => Promise<void>;
};

export type ExtensionInstallErrorCode =
	| "UNSUPPORTED_BROWSER"
	| "DESTINATION_UNAVAILABLE"
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

export const supportedBrowserOptions: readonly SupportedBrowserOption[] = [
	{
		id: "chrome",
		name: "Google Chrome",
		shortName: "Chrome",
		description: "Chrome ウェブストアまたは開発版の読み込みに対応します。",
		managementUrl: "chrome://extensions",
		developmentOutputPath: "apps/extension/.output/chrome-mv3",
		developmentGuideUrl:
			"https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked",
		storeUrl: null,
	},
	{
		id: "edge",
		name: "Microsoft Edge",
		shortName: "Edge",
		description: "Edge アドオンまたは開発版の読み込みに対応します。",
		managementUrl: "edge://extensions",
		developmentOutputPath: "apps/extension/.output/chrome-mv3",
		developmentGuideUrl:
			"https://learn.microsoft.com/ja-jp/microsoft-edge/extensions/getting-started/extension-sideloading",
		storeUrl: null,
	},
] as const;

const extensionInstallStorageKey = "fuzzy.desktop.extensionInstall";
const installStatuses: readonly ExtensionInstallStatus[] = [
	"not-started",
	"destination-opened",
	"confirmed",
];
const installChannels: readonly ExtensionInstallChannel[] = ["development", "store"];

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

async function createRuntimeOpener(): Promise<ExtensionInstallOpener | null> {
	if (!isTauriRuntime()) {
		return null;
	}

	const { openUrl } = await import("@tauri-apps/plugin-opener");

	return { openUrl };
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

export function getSupportedBrowserOption(browserId: BrowserChoice): SupportedBrowserOption | null {
	return supportedBrowserOptions.find(({ id }) => id === browserId) ?? null;
}

export function createInitialExtensionInstallState(
	browserId: BrowserChoice,
): ExtensionInstallState {
	return {
		browserId,
		channel: "development",
		status: "not-started",
		updatedAt: new Date(0).toISOString(),
	};
}

export function parseExtensionInstallState(value: unknown): ExtensionInstallState | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const candidate = value as Partial<ExtensionInstallState>;

	if (
		!isBrowserChoice(candidate.browserId) ||
		!isInstallChannel(candidate.channel) ||
		!isInstallStatus(candidate.status) ||
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
		channel: candidate.channel,
		status: candidate.status,
		lastOpenedAt: candidate.lastOpenedAt,
		completedAt: candidate.completedAt,
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

export function getExtensionInstallDestination(
	browserId: BrowserChoice,
	channel: ExtensionInstallChannel,
): ExtensionInstallDestination {
	const browser = getSupportedBrowserOption(browserId);

	if (!browser) {
		return {
			available: false,
			kind: channel,
			label: "未対応ブラウザ",
			displayTarget: null,
			openTarget: null,
			reason: "Google Chrome または Microsoft Edge を選択してください。",
		};
	}

	if (channel === "store") {
		return {
			available: browser.storeUrl !== null,
			kind: channel,
			label: `${browser.shortName} の公式ストア`,
			displayTarget: browser.storeUrl,
			openTarget: browser.storeUrl,
			reason: browser.storeUrl === null ? "公式ストアの配布URLはまだ設定されていません。" : null,
		};
	}

	return {
		available: true,
		kind: channel,
		label: `${browser.shortName} の開発版導入ガイド`,
		displayTarget: browser.developmentOutputPath,
		openTarget: browser.developmentGuideUrl,
		reason: null,
	};
}

export async function openExtensionInstallDestinationClient(
	browserId: BrowserChoice,
	channel: ExtensionInstallChannel,
	opener?: ExtensionInstallOpener | null,
): Promise<ExtensionInstallOpenResult> {
	const destination = getExtensionInstallDestination(browserId, channel);

	if (browserId === "unsupported") {
		throw new ExtensionInstallError(
			"UNSUPPORTED_BROWSER",
			destination.reason ?? "このブラウザには対応していません。",
		);
	}

	if (!destination.available || !destination.openTarget) {
		throw new ExtensionInstallError(
			"DESTINATION_UNAVAILABLE",
			destination.reason ?? "導入先を利用できません。",
		);
	}

	const runtimeOpener = opener === undefined ? await createRuntimeOpener() : opener;

	if (!runtimeOpener) {
		return { destination, mocked: true };
	}

	try {
		await runtimeOpener.openUrl(destination.openTarget);
	} catch {
		throw new ExtensionInstallError(
			"OPEN_FAILED",
			"導入先を開けませんでした。拡張機能をビルドしてから再試行してください。",
		);
	}

	return { destination, mocked: false };
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
