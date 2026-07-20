import {
	EXTENSION_RUNTIME_PROTOCOL_VERSION,
	type ExtensionRuntimeObservation,
	type ExtensionRuntimeReport,
	NativeApiClient,
} from "@fuzzy/shared";

const INSTALLATION_ID_STORAGE_KEY = "fuzzy.extension.installationId";

export interface InstallationIdStorage {
	get(key: string): Promise<Record<string, unknown>>;
	set(values: Record<string, unknown>): Promise<void>;
}

/** 再インストールを区別できる、ブラウザプロファイル内だけの安定したIDを取得する。 */
export async function getOrCreateInstallationId(
	storage: InstallationIdStorage,
	createId: () => string = () => crypto.randomUUID(),
): Promise<string> {
	const stored = await storage.get(INSTALLATION_ID_STORAGE_KEY);
	const current = stored[INSTALLATION_ID_STORAGE_KEY];

	if (typeof current === "string" && /^[a-zA-Z0-9-]{1,128}$/.test(current)) {
		return current;
	}

	const installationId = createId();
	if (!/^[a-zA-Z0-9-]{1,128}$/.test(installationId)) {
		throw new Error("拡張機能のインストール識別子を生成できませんでした");
	}
	await storage.set({ [INSTALLATION_ID_STORAGE_KEY]: installationId });
	return installationId;
}

export function createExtensionRuntimeReport(
	installationId: string,
	extensionVersion: string,
): ExtensionRuntimeReport {
	return {
		installationId,
		extensionVersion,
		protocolVersion: EXTENSION_RUNTIME_PROTOCOL_VERSION,
	};
}

export interface ReportCurrentExtensionRuntimeOptions {
	storage?: InstallationIdStorage;
	client?: Pick<NativeApiClient, "reportExtensionRuntime">;
	extensionVersion?: string;
	createId?: () => string;
}

/**
 * 拡張機能の実応答をnative-hostへ送り、SQLiteへの保存完了を待つ。
 * ブラウザ名やUser-Agentは送らない。
 */
export async function reportCurrentExtensionRuntime(
	options: ReportCurrentExtensionRuntimeOptions = {},
): Promise<ExtensionRuntimeObservation> {
	const storage = options.storage ?? browser.storage.local;
	const installationId = await getOrCreateInstallationId(storage, options.createId);
	const extensionVersion = options.extensionVersion ?? browser.runtime.getManifest().version;
	const client = options.client ?? new NativeApiClient();

	return client.reportExtensionRuntime(
		createExtensionRuntimeReport(installationId, extensionVersion),
	);
}
