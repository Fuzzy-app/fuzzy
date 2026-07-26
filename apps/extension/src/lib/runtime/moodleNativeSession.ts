/** 認証済みMoodleタブが開いている間だけbackgroundへ接続を維持するためのPort名。 */
export const MOODLE_NATIVE_SESSION_PORT = "fuzzy:moodleNativeSession";

interface DisconnectEvent {
	addListener(listener: () => void): void;
}

export interface MoodleNativeSessionPort {
	readonly onDisconnect: DisconnectEvent;
	disconnect(): void;
}

export interface MoodleNativeSessionOptions {
	connect(): MoodleNativeSessionPort;
	isPageActive(): boolean;
	setTimer?: (callback: () => void, delayMs: number) => unknown;
	clearTimer?: (timer: unknown) => void;
	initialRetryMs?: number;
	maxRetryMs?: number;
}

/**
 * MV3 Service Workerの終了などでPortが切断されても、表示中のMoodleページから再接続する。
 * ページ破棄後は再試行せず、保持中のPortとタイマーを必ず解放する。
 */
export function maintainMoodleNativeSession(options: MoodleNativeSessionOptions): () => void {
	const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
	const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as number));
	const initialRetryMs = options.initialRetryMs ?? 250;
	const maxRetryMs = options.maxRetryMs ?? 5_000;
	let retryMs = initialRetryMs;
	let port: MoodleNativeSessionPort | null = null;
	let reconnectTimer: unknown = null;
	let disposed = false;

	const shouldConnect = (): boolean => !disposed && options.isPageActive();

	const scheduleReconnect = (): void => {
		if (!shouldConnect() || reconnectTimer !== null) return;
		const delayMs = retryMs;
		retryMs = Math.min(retryMs * 2, maxRetryMs);
		reconnectTimer = setTimer(() => {
			reconnectTimer = null;
			connect();
		}, delayMs);
	};

	const connect = (): void => {
		if (!shouldConnect() || port) return;
		try {
			const nextPort = options.connect();
			port = nextPort;
			retryMs = initialRetryMs;
			nextPort.onDisconnect.addListener(() => {
				if (port !== nextPort) return;
				port = null;
				scheduleReconnect();
			});
		} catch {
			scheduleReconnect();
		}
	};

	connect();

	return () => {
		if (disposed) return;
		disposed = true;
		if (reconnectTimer !== null) {
			clearTimer(reconnectTimer);
			reconnectTimer = null;
		}
		const currentPort = port;
		port = null;
		currentPort?.disconnect();
	};
}
