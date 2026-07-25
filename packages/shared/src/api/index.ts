import { ApiError, type FuzzyApiClient } from "./client";
import { NativeApiClient } from "./nativeClient";

export type { FuzzyApiClient } from "./client";
export { ApiError } from "./client";
export { MockApiClient } from "./mockClient";
export { NativeApiClient } from "./nativeClient";

export interface CreateApiClientOptions {
	/** ping応答を待つ上限時間(ms)。超えた場合はNO_NATIVE_HOSTとして扱う */
	timeoutMs?: number;
	/** ログを出すかどうか（デフォルト true） */
	verbose?: boolean;
}

/**
 * native-hostへの接続を確認し、実データ用クライアントだけを返す。
 *
 * 本番でサンプルデータへ暗黙に切り替えるとSQLite正本と見分けがつかなくなるため、
 * 未接続時は明示的なNO_NATIVE_HOSTとする。MockApiClientはテストや画面開発で
 * 明示生成する場合だけ使用する。
 */
export async function createApiClient(
	options: CreateApiClientOptions = {},
): Promise<FuzzyApiClient> {
	const { timeoutMs = 5_000, verbose = true } = options;
	const native = new NativeApiClient({ requestTimeoutMs: timeoutMs });
	const reachable = await native.ping();

	if (reachable) {
		if (verbose) console.info("[fuzzy] native-host に接続しました（mode=native）");
		return native;
	}

	native.disconnect();
	if (verbose) {
		console.warn("[fuzzy] native-host に接続できませんでした");
	}
	throw new ApiError(
		"NO_NATIVE_HOST",
		"native-hostに接続できません。Fuzzyを起動し、接続状態を確認してから再試行してください。",
	);
}
