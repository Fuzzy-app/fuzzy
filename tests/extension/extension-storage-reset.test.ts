import { describe, expect, test } from "bun:test";
import {
	EXTENSION_STORAGE_FORMAT,
	EXTENSION_STORAGE_FORMAT_KEY,
	resetExtensionOwnedStorage,
} from "../../apps/extension/src/lib/extensionStorageReset";

function createStorage(initial: Record<string, unknown>) {
	const values = new Map(Object.entries(initial));
	return {
		async get(keys: string | null) {
			if (keys === null) return Object.fromEntries(values);
			return { [keys]: values.get(keys) };
		},
		async remove(keys: string[]) {
			for (const key of keys) values.delete(key);
		},
		async set(items: Record<string, unknown>) {
			for (const [key, value] of Object.entries(items)) values.set(key, value);
		},
		values,
	};
}

describe("拡張機能の内部データ形式", () => {
	test("形式変更時はFuzzyの派生データだけを消し、installationIdを残す", async () => {
		const storage = createStorage({
			"fuzzy-last-notified-sync-event:native": 4,
			"fuzzy:savePanelOpen": true,
			"fuzzy.extension.installationId": "stable-installation",
			otherExtensionValue: "keep",
		});

		await resetExtensionOwnedStorage(storage);

		expect(storage.values.get("fuzzy-last-notified-sync-event:native")).toBeUndefined();
		expect(storage.values.get("fuzzy:savePanelOpen")).toBeUndefined();
		expect(storage.values.get("fuzzy.extension.installationId")).toBe("stable-installation");
		expect(storage.values.get("otherExtensionValue")).toBe("keep");
		expect(storage.values.get(EXTENSION_STORAGE_FORMAT_KEY)).toBe(EXTENSION_STORAGE_FORMAT);
	});

	test("同じ形式なら保存値を消さずに再利用する", async () => {
		const storage = createStorage({
			[EXTENSION_STORAGE_FORMAT_KEY]: EXTENSION_STORAGE_FORMAT,
			"fuzzy-last-notified-sync-event:native": 4,
		});

		await resetExtensionOwnedStorage(storage);

		expect(storage.values.get("fuzzy-last-notified-sync-event:native")).toBe(4);
	});
});
