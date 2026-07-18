import { describe, expect, test } from "bun:test";
import {
	SAVE_PANEL_OPEN_STATE_KEY,
	type SavePanelStateStorage,
	createSavePanelOpenStateWriter,
	loadSavePanelOpenState,
} from "../../apps/extension/src/entrypoints/content/savePanelState";

describe("保存パネルの開閉状態", () => {
	test("保存済みの真偽値だけを復元する", async () => {
		expect(await loadSavePanelOpenState(createStorage(true))).toBe(true);
		expect(await loadSavePanelOpenState(createStorage(false))).toBe(false);
		expect(await loadSavePanelOpenState(createStorage("true"))).toBe(false);
		expect(await loadSavePanelOpenState(createStorage(undefined))).toBe(false);
	});

	test("読み込み失敗時は閉じた状態へフォールバックする", async () => {
		const errors: unknown[] = [];
		const storage: SavePanelStateStorage = {
			get: async () => {
				throw new Error("storage unavailable");
			},
			set: async () => {},
		};
		expect(await loadSavePanelOpenState(storage, (error) => errors.push(error))).toBe(false);
		expect(errors).toHaveLength(1);
	});

	test("連続した開閉操作を順番どおり保存する", async () => {
		const writes: boolean[] = [];
		let releaseFirstWrite: (() => void) | undefined;
		const firstWritePending = new Promise<void>((resolve) => {
			releaseFirstWrite = resolve;
		});
		const storage: SavePanelStateStorage = {
			get: async () => ({}),
			set: async (items) => {
				const value = items[SAVE_PANEL_OPEN_STATE_KEY] === true;
				writes.push(value);
				if (writes.length === 1) await firstWritePending;
			},
		};
		const save = createSavePanelOpenStateWriter(storage);
		const openWrite = save(true);
		const closeWrite = save(false);

		await Promise.resolve();
		expect(writes).toEqual([true]);
		releaseFirstWrite?.();
		await Promise.all([openWrite, closeWrite]);
		expect(writes).toEqual([true, false]);
	});
});

function createStorage(value: unknown): SavePanelStateStorage {
	return {
		get: async () => ({ [SAVE_PANEL_OPEN_STATE_KEY]: value }),
		set: async () => {},
	};
}
