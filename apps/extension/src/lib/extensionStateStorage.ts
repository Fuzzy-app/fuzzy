/** browser.storage.local とテスト用実装に共通する最小インターフェース。 */
export interface ExtensionStateStorage {
	get(key: string): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
}

export type ExtensionStateErrorHandler = (error: unknown) => void;
