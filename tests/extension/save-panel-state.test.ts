import { describe, expect, test } from "bun:test";
import {
	SAVE_PANEL_FORCE_CLOSED_ONCE_KEY,
	SAVE_PANEL_OPEN_STATE_KEY,
	type SavePanelStateStorage,
	createSavePanelOpenStateWriter,
	loadSavePanelOpenState,
	requestSavePanelClosedOnNextMount,
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

	test("再ログイン前に次回だけ閉じる指示を保存する", async () => {
		const writes: Record<string, unknown>[] = [];
		const storage: SavePanelStateStorage = {
			get: async () => ({}),
			set: async (items) => {
				writes.push(items);
			},
		};
		expect(await requestSavePanelClosedOnNextMount(storage)).toBe(true);
		expect(writes).toEqual([{ [SAVE_PANEL_FORCE_CLOSED_ONCE_KEY]: true }]);

		const errors: unknown[] = [];
		expect(
			await requestSavePanelClosedOnNextMount(
				{
					get: async () => ({}),
					set: async () => {
						throw new Error("storage unavailable");
					},
				},
				(error) => errors.push(error),
			),
		).toBe(false);
		expect(errors).toHaveLength(1);
	});

	test("遷移元の遅延書き込み後も次回マウントだけ閉じる", async () => {
		const stored: Record<string, unknown> = { [SAVE_PANEL_OPEN_STATE_KEY]: false };
		let releaseOldPageWrite: (() => void) | undefined;
		const oldPageWritePending = new Promise<void>((resolve) => {
			releaseOldPageWrite = resolve;
		});
		const storage: SavePanelStateStorage = {
			get: async (key) => ({ [key]: stored[key] }),
			set: async (items) => {
				if (items[SAVE_PANEL_OPEN_STATE_KEY] === true) await oldPageWritePending;
				Object.assign(stored, items);
			},
		};
		const writeOpenState = createSavePanelOpenStateWriter(storage);
		const staleWrite = writeOpenState(true);
		await Promise.resolve();

		expect(await requestSavePanelClosedOnNextMount(storage)).toBe(true);
		releaseOldPageWrite?.();
		await staleWrite;
		expect(stored[SAVE_PANEL_OPEN_STATE_KEY]).toBe(true);
		expect(await loadSavePanelOpenState(storage)).toBe(false);
		expect(stored[SAVE_PANEL_FORCE_CLOSED_ONCE_KEY]).toBe(false);
		// 一度消費した後は通常の保存値を復元する。
		expect(await loadSavePanelOpenState(storage)).toBe(true);
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
		get: async (key) => ({ [key]: key === SAVE_PANEL_OPEN_STATE_KEY ? value : undefined }),
		set: async () => {},
	};
}
