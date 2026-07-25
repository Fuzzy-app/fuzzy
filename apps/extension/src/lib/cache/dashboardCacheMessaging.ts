import type { CachedDashboard } from "./dashboardCache";

/**
 * content script の IndexedDB は閲覧中ページの origin に属するため、
 * 拡張機能 origin のキャッシュは background 経由で読み取る。
 */
export const FUZZY_DASHBOARD_CACHE_READ_MESSAGE = "fuzzy:readDashboardCache";

export interface DashboardCacheReadRequestMessage {
	type: typeof FUZZY_DASHBOARD_CACHE_READ_MESSAGE;
}

export type DashboardCacheReadResponseMessage =
	| { ok: true; data: CachedDashboard | null }
	| { ok: false; error: { code: string; message: string } };

export function isDashboardCacheReadRequestMessage(
	message: unknown,
): message is DashboardCacheReadRequestMessage {
	return (
		typeof message === "object" &&
		message !== null &&
		(message as { type?: unknown }).type === FUZZY_DASHBOARD_CACHE_READ_MESSAGE
	);
}

export async function readDashboardCacheFromBackground(): Promise<CachedDashboard | null> {
	const response = (await browser.runtime.sendMessage({
		type: FUZZY_DASHBOARD_CACHE_READ_MESSAGE,
	} satisfies DashboardCacheReadRequestMessage)) as DashboardCacheReadResponseMessage | undefined;

	if (!response) throw new Error("backgroundからキャッシュの応答がありません");
	if (!response.ok) throw new Error(response.error.message);
	return response.data;
}
