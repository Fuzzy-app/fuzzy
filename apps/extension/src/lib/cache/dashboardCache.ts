import type { DashboardSummary } from "@fuzzy/shared";

const DATABASE_NAME = "fuzzy-display-cache";
const DATABASE_VERSION = 1;
const STORE_NAME = "dashboard";
const CACHE_KEY = "latest";

export interface CachedDashboard {
	dashboard: DashboardSummary;
	cachedAt: string;
}

function openDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(STORE_NAME)) {
				request.result.createObjectStore(STORE_NAME);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

export async function readDashboardCache(): Promise<CachedDashboard | null> {
	if (!("indexedDB" in globalThis)) return null;
	try {
		const database = await openDatabase();
		const cached = await new Promise<CachedDashboard | undefined>((resolve, reject) => {
			const transaction = database.transaction(STORE_NAME, "readonly");
			const request = transaction.objectStore(STORE_NAME).get(CACHE_KEY);
			request.onsuccess = () => resolve(request.result as CachedDashboard | undefined);
			request.onerror = () => reject(request.error);
		});
		database.close();
		return cached ?? null;
	} catch (error) {
		console.warn("[fuzzy] ダッシュボードキャッシュを読み込めませんでした", error);
		return null;
	}
}

export async function writeDashboardCache(dashboard: DashboardSummary): Promise<void> {
	if (!("indexedDB" in globalThis)) return;
	try {
		const database = await openDatabase();
		await new Promise<void>((resolve, reject) => {
			const transaction = database.transaction(STORE_NAME, "readwrite");
			transaction
				.objectStore(STORE_NAME)
				.put(
					{ dashboard, cachedAt: new Date().toISOString() } satisfies CachedDashboard,
					CACHE_KEY,
				);
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
			transaction.onabort = () => reject(transaction.error);
		});
		database.close();
	} catch (error) {
		console.warn("[fuzzy] ダッシュボードキャッシュを保存できませんでした", error);
	}
}
