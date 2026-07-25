import type { FuzzyApiClient } from "@fuzzy/shared";

export interface RecoveringApiClientProvider {
	getClient(): Promise<FuzzyApiClient>;
	/** 接続エラーまたはhost復旧確認後に、次回取得で疎通を再判定する。 */
	invalidate(): void;
	/** Moodleタブがなくなったときに保持中のNative Messaging接続を終了する。 */
	dispose(): void;
	readonly mode: FuzzyApiClient["mode"] | null;
}

interface RecoveringApiClientOptions {
	createClient(): Promise<FuzzyApiClient>;
	mockRetryMs?: number;
	now?: () => number;
}

/**
 * 初回失敗でmockを永久キャッシュせず、一定時間後にnative-hostを再確認する。
 * 同時呼び出しは同じPromiseへまとめ、古い試行が後から完了しても現在の接続を上書きしない。
 */
export function createRecoveringApiClientProvider(
	options: RecoveringApiClientOptions,
): RecoveringApiClientProvider {
	const mockRetryMs = options.mockRetryMs ?? 5_000;
	const now = options.now ?? Date.now;
	let currentPromise: Promise<FuzzyApiClient> | null = null;
	let currentMode: FuzzyApiClient["mode"] | null = null;
	let attemptedAt = 0;
	let generation = 0;

	const releaseCurrent = (): void => {
		generation += 1;
		const released = currentPromise;
		currentPromise = null;
		currentMode = null;
		if (released) void released.then(disconnectIfSupported, () => undefined);
	};

	const getClient = (): Promise<FuzzyApiClient> => {
		if (currentPromise && (currentMode !== "mock" || now() - attemptedAt < mockRetryMs)) {
			return currentPromise;
		}
		if (currentPromise) releaseCurrent();

		const attemptGeneration = ++generation;
		attemptedAt = now();
		const attempt = options
			.createClient()
			.then((client) => {
				if (attemptGeneration !== generation || currentPromise !== attempt) {
					disconnectIfSupported(client);
					return client;
				}
				currentMode = client.mode;
				return client;
			})
			.catch((error) => {
				if (attemptGeneration === generation && currentPromise === attempt) {
					currentPromise = null;
					currentMode = null;
				}
				throw error;
			});
		currentPromise = attempt;
		return attempt;
	};

	return {
		getClient,
		invalidate: releaseCurrent,
		dispose: releaseCurrent,
		get mode() {
			return currentMode;
		},
	};
}

function disconnectIfSupported(client: FuzzyApiClient): void {
	const disconnect = (client as FuzzyApiClient & { disconnect?: () => void }).disconnect;
	if (typeof disconnect === "function") disconnect.call(client);
}
