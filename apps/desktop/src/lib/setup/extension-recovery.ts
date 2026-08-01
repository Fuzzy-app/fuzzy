import type { ExtensionRecoveryStatus } from "@fuzzy/shared";
import {
	ExtensionInstallError,
	createStatusRuntime,
	isTauriRuntime,
	parseExtensionRuntimeObservation,
} from "./extension-install";
import type { ExtensionStatusRuntime } from "./extension-install";

export type UrlOpenRuntime = {
	openUrl: (url: string) => Promise<void>;
};

export type ExtensionRecoveryViewState =
	| "missing"
	| "ready"
	| "stale"
	| "checking"
	| "timed-out"
	| "incompatible";

export const extensionRuntimeRecentSeconds = 24 * 60 * 60;
export const recoveryRecheckTimeoutMs = 15_000;
export const moodleRecoveryUrl = "https://moodle.wakayama-u.ac.jp/";

export function parseExtensionRecoveryStatus(value: unknown): ExtensionRecoveryStatus | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	if (
		candidate.state !== "missing" &&
		candidate.state !== "ready" &&
		candidate.state !== "stale" &&
		candidate.state !== "incompatible"
	) {
		return null;
	}
	if (
		typeof candidate.recentWithinSeconds !== "number" ||
		!Number.isInteger(candidate.recentWithinSeconds) ||
		candidate.recentWithinSeconds <= 0
	) {
		return null;
	}
	if (candidate.state === "missing") {
		return candidate.observation === null
			? {
					state: "missing",
					observation: null,
					recentWithinSeconds: candidate.recentWithinSeconds,
				}
			: null;
	}

	const observation = parseExtensionRuntimeObservation(candidate.observation);
	if (!observation) return null;
	return {
		state: candidate.state,
		observation,
		recentWithinSeconds: candidate.recentWithinSeconds,
	};
}

export async function getExtensionRecoveryStatusClient(
	runtime?: ExtensionStatusRuntime | null,
): Promise<ExtensionRecoveryStatus> {
	const statusRuntime = runtime === undefined ? await createStatusRuntime() : runtime;
	if (!statusRuntime) {
		return {
			state: "missing",
			observation: null,
			recentWithinSeconds: extensionRuntimeRecentSeconds,
		};
	}

	try {
		const value = await statusRuntime.invoke<unknown>("get_extension_recovery_status", {});
		const status = parseExtensionRecoveryStatus(value);
		if (!status) throw new Error("invalid response");
		return status;
	} catch {
		throw new ExtensionInstallError(
			"STATUS_UNAVAILABLE",
			"拡張機能の状態を読み込めませんでした。Fuzzyを再起動してから再試行してください。",
		);
	}
}

export function deriveExtensionRecoveryViewState(
	status: ExtensionRecoveryStatus,
	recheckStartedAt: string | null,
	nowMs: number = Date.now(),
	timeoutMs: number = recoveryRecheckTimeoutMs,
): ExtensionRecoveryViewState {
	if (status.state !== "stale") return status.state;
	if (!recheckStartedAt) return "stale";

	const startedAtMs = Date.parse(recheckStartedAt);
	if (Number.isNaN(startedAtMs)) return "stale";
	return nowMs - startedAtMs >= timeoutMs ? "timed-out" : "checking";
}

export function getMoodleRecoveryUrl(): string {
	return moodleRecoveryUrl;
}

export async function openMoodleForRecoveryClient(
	runtime?: UrlOpenRuntime | null,
): Promise<string> {
	const url = getMoodleRecoveryUrl();
	let opener = runtime;
	if (opener === undefined) {
		opener = isTauriRuntime()
			? { openUrl: (await import("@tauri-apps/plugin-opener")).openUrl }
			: null;
	}
	if (opener) {
		try {
			await opener.openUrl(url);
		} catch {
			throw new ExtensionInstallError(
				"OPEN_FAILED",
				"Moodleを既定のブラウザで開けませんでした。ブラウザからMoodleを開いて再確認してください。",
			);
		}
	}
	return url;
}
