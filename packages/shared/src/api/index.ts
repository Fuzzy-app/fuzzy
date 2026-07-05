import type { FuzzyApiClient } from "./client";
import { MockApiClient } from "./mockClient";
import { NativeApiClient } from "./nativeClient";

export type { FuzzyApiClient } from "./client";
export { ApiError } from "./client";
export { MockApiClient } from "./mockClient";
export { NativeApiClient } from "./nativeClient";

export interface CreateApiClientOptions {
	/** ping応答を待つ上限時間(ms)。超えたらサンプルデータにフォールバックする */
	timeoutMs?: number;
	/** ログを出すかどうか（デフォルト true） */
	verbose?: boolean;
}

/**
 * native-host への接続を試み、応答が無ければサンプルデータ(MockApiClient)にフォールバックする。
 * 拡張機能の各画面はこの関数経由でクライアントを取得し、native/mockどちらかを意識しない。
 *
 * 例:
 *   const api = await createApiClient();
 *   const dashboard = await api.getDashboard(); // native-host未起動でもサンプルデータが返る
 */
export async function createApiClient(
	options: CreateApiClientOptions = {},
): Promise<FuzzyApiClient> {
	const { timeoutMs = 800, verbose = true } = options;
	const native = new NativeApiClient();

	const pingWithTimeout = Promise.race([
		native.ping(),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
	]).catch(() => false);

	const reachable = await pingWithTimeout;

	if (reachable) {
		if (verbose) console.info("[fuzzy] native-host に接続しました（mode=native）");
		return native;
	}

	if (verbose) {
		console.warn(
			"[fuzzy] native-host に接続できませんでした。サンプルデータにフォールバックします（mode=mock）",
		);
	}
	return new MockApiClient();
}
