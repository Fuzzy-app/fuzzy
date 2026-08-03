import type { DashboardSummary } from "@fuzzy/shared";

// Issue #59以前にcontent scriptがMoodle originへ保存したmock混在キャッシュと
// 名前空間を分け、native-hostから取得した実データだけを表示する。
const DATABASE_NAME = "fuzzy-native-display-cache-v3";
const LEGACY_DATABASE_NAMES = ["fuzzy-native-display-cache-v2"];
const DATABASE_VERSION = 1;
const STORE_NAME = "dashboard";
const CACHE_KEY = "latest-native-v2";
const CACHE_FORMAT_VERSION = 2;

export interface CachedDashboard {
	formatVersion: typeof CACHE_FORMAT_VERSION;
	source: "native";
	dashboard: DashboardSummary;
	cachedAt: string;
}

function openDatabase(): Promise<IDBDatabase> {
	return clearLegacyDatabases().then(
		() =>
			new Promise((resolve, reject) => {
				const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
				request.onupgradeneeded = () => {
					if (!request.result.objectStoreNames.contains(STORE_NAME)) {
						request.result.createObjectStore(STORE_NAME);
					}
				};
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			}),
	);
}

let legacyDatabaseCleanup: Promise<void> | null = null;

function clearLegacyDatabases(): Promise<void> {
	if (legacyDatabaseCleanup) return legacyDatabaseCleanup;
	legacyDatabaseCleanup = Promise.all(
		LEGACY_DATABASE_NAMES.map(
			(name) =>
				new Promise<void>((resolve) => {
					const request = indexedDB.deleteDatabase(name);
					request.onsuccess = () => resolve();
					request.onerror = () => resolve();
					request.onblocked = () => resolve();
				}),
		),
	).then(() => undefined);
	return legacyDatabaseCleanup;
}

export async function readDashboardCache(): Promise<CachedDashboard | null> {
	if (!("indexedDB" in globalThis)) return null;
	try {
		const database = await openDatabase();
		const cached = await new Promise<CachedDashboard | undefined>((resolve, reject) => {
			const transaction = database.transaction(STORE_NAME, "readonly");
			const request = transaction.objectStore(STORE_NAME).get(CACHE_KEY);
			request.onsuccess = () => resolve(parseCachedDashboard(request.result) ?? undefined);
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
			transaction.objectStore(STORE_NAME).put(
				{
					formatVersion: CACHE_FORMAT_VERSION,
					source: "native",
					dashboard,
					cachedAt: new Date().toISOString(),
				} satisfies CachedDashboard,
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

export function parseCachedDashboard(value: unknown): CachedDashboard | null {
	if (!value || typeof value !== "object") return null;
	const cached = value as Record<string, unknown>;
	if (
		cached.formatVersion !== CACHE_FORMAT_VERSION ||
		cached.source !== "native" ||
		typeof cached.cachedAt !== "string" ||
		Number.isNaN(Date.parse(cached.cachedAt)) ||
		!isDashboardSummary(cached.dashboard)
	) {
		return null;
	}
	return cached as unknown as CachedDashboard;
}

function isDashboardSummary(value: unknown): value is DashboardSummary {
	if (!value || typeof value !== "object") return false;
	const dashboard = value as Record<string, unknown>;
	if (
		!isNonNegativeInteger(dashboard.totalFiles) ||
		!isNonNegativeInteger(dashboard.totalViolations) ||
		!isNonNegativeInteger(dashboard.upcomingDeadlineCount) ||
		!Array.isArray(dashboard.courses)
	) {
		return false;
	}
	return dashboard.courses.every((value) => {
		if (!value || typeof value !== "object") return false;
		const course = value as Record<string, unknown>;
		return (
			typeof course.courseId === "number" &&
			Number.isSafeInteger(course.courseId) &&
			course.courseId > 0 &&
			typeof course.courseName === "string" &&
			course.courseName.length > 0 &&
			isNonNegativeInteger(course.fileCount) &&
			isNonNegativeInteger(course.violationCount) &&
			(course.nextDueAt === null ||
				(typeof course.nextDueAt === "string" && !Number.isNaN(Date.parse(course.nextDueAt))))
		);
	});
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
