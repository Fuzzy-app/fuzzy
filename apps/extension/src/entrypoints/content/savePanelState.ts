import type {
	ExtensionStateErrorHandler,
	ExtensionStateStorage,
} from "../../lib/extensionStateStorage";

export const SAVE_PANEL_OPEN_STATE_KEY = "fuzzy:savePanelOpen";
export const SAVE_PANEL_FORCE_CLOSED_ONCE_KEY = "fuzzy:forceSavePanelClosedOnce";

export type SavePanelStateStorage = ExtensionStateStorage;

/** 保存済みの開閉状態を読み込む。未保存または取得失敗時は閉じた状態を使う。 */
export async function loadSavePanelOpenState(
	storage: SavePanelStateStorage,
	onError: ExtensionStateErrorHandler = defaultLoadErrorHandler,
): Promise<boolean> {
	try {
		const forcedState = await storage.get(SAVE_PANEL_FORCE_CLOSED_ONCE_KEY);
		if (forcedState[SAVE_PANEL_FORCE_CLOSED_ONCE_KEY] === true) {
			// 通常の開閉状態とは別キーで受け渡すため、遷移前ページの遅延書き込みに上書きされない。
			await storage.set({ [SAVE_PANEL_FORCE_CLOSED_ONCE_KEY]: false });
			return false;
		}
		const stored = await storage.get(SAVE_PANEL_OPEN_STATE_KEY);
		return stored[SAVE_PANEL_OPEN_STATE_KEY] === true;
	} catch (error) {
		onError(error);
		return false;
	}
}

/** 次に保存パネルをマウントする一度だけ、通常の保存値に関係なく閉じた状態から始める。 */
export async function requestSavePanelClosedOnNextMount(
	storage: SavePanelStateStorage,
	onError: ExtensionStateErrorHandler = defaultSaveErrorHandler,
): Promise<boolean> {
	try {
		await storage.set({ [SAVE_PANEL_FORCE_CLOSED_ONCE_KEY]: true });
		return true;
	} catch (error) {
		onError(error);
		return false;
	}
}

/** 連続操作でも最後の状態が必ず最後に書き込まれる、直列化済みの保存関数を作る。 */
export function createSavePanelOpenStateWriter(
	storage: SavePanelStateStorage,
	onError: ExtensionStateErrorHandler = defaultSaveErrorHandler,
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
