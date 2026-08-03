/**
 * 拡張機能がbrowser.storage.localへ保存する派生データの形式を管理する。
 * Native-hostのSQLite正本や、再インストールを区別するinstallationIdは削除しない。
 */

export const EXTENSION_STORAGE_FORMAT_KEY = "fuzzy-extension-storage-format";
// アプリ再インストール時も古い表示用キャッシュを引き継がない。
export const EXTENSION_STORAGE_FORMAT = 3;

export interface ExtensionOwnedStorage {
	get(keys: string | null): Promise<Record<string, unknown>>;
	remove(keys: string[]): Promise<void>;
	set(items: Record<string, unknown>): Promise<void>;
}

export async function resetExtensionOwnedStorage(storage: ExtensionOwnedStorage): Promise<void> {
	const stored = await storage.get(EXTENSION_STORAGE_FORMAT_KEY);
	if (stored[EXTENSION_STORAGE_FORMAT_KEY] === EXTENSION_STORAGE_FORMAT) return;

	const all = await storage.get(null);
	const keysToRemove = Object.keys(all).filter(
		(key) => key.startsWith("fuzzy-") || key.startsWith("fuzzy:"),
	);
	if (keysToRemove.length > 0) await storage.remove(keysToRemove);
	await storage.set({ [EXTENSION_STORAGE_FORMAT_KEY]: EXTENSION_STORAGE_FORMAT });
}
