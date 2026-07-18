export const SAVE_PANEL_OPEN_STATE_KEY = "fuzzy:savePanelOpen";

export interface SavePanelStateStorage {
	get(key: string): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
}

type StateErrorHandler = (error: unknown) => void;

/** 保存済みの開閉状態を読み込む。未保存または取得失敗時は閉じた状態を使う。 */
export async function loadSavePanelOpenState(
	storage: SavePanelStateStorage,
	onError: StateErrorHandler = defaultLoadErrorHandler,
): Promise<boolean> {
	try {
		const stored = await storage.get(SAVE_PANEL_OPEN_STATE_KEY);
		return stored[SAVE_PANEL_OPEN_STATE_KEY] === true;
	} catch (error) {
		onError(error);
		return false;
	}
}

/** 連続操作でも最後の状態が必ず最後に書き込まれる、直列化済みの保存関数を作る。 */
export function createSavePanelOpenStateWriter(
	storage: SavePanelStateStorage,
	onError: StateErrorHandler = defaultSaveErrorHandler,
): (isOpen: boolean) => Promise<void> {
	let pendingWrite = Promise.resolve();
	return (isOpen: boolean) => {
		pendingWrite = pendingWrite
			.then(() => storage.set({ [SAVE_PANEL_OPEN_STATE_KEY]: isOpen }))
			.catch(onError);
		return pendingWrite;
	};
}

function defaultLoadErrorHandler(error: unknown): void {
	console.warn("[fuzzy] 保存パネルの開閉状態を読み込めませんでした", error);
}

function defaultSaveErrorHandler(error: unknown): void {
	console.warn("[fuzzy] 保存パネルの開閉状態を記憶できませんでした", error);
}
