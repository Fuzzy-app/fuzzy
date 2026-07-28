import type { FuzzyApiClient } from "@fuzzy/shared";
import { MOODLE_HOME_URL, MOODLE_HTTPS_MATCH_PATTERN } from "../../../moodleSite";

export const SYNC_NOTIFICATION_ID_PREFIX = "fuzzy-sync-";
export const SYNC_SCREEN_NAVIGATION_MESSAGE = "fuzzy:open-screen";
export const PENDING_SYNC_SCREEN_NAVIGATION_KEY = "fuzzy-pending-sync-screen-navigation";

export interface SyncNotificationReference {
	mode: Exclude<FuzzyApiClient["mode"], "mock">;
	syncEventId: number;
}

export interface DeadlineScreenNavigationMessage {
	type: typeof SYNC_SCREEN_NAVIGATION_MESSAGE;
	screen: "deadlines";
	syncEventId: number;
}

export interface ScreenNavigationResponse {
	handled: true;
}

interface MoodleTab {
	id?: number;
	active?: boolean;
}

export interface SyncNavigationBrowser {
	storage: {
		local: {
			set(items: Record<string, unknown>): Promise<void>;
			remove(key: string): Promise<void>;
		};
	};
	tabs: {
		query(query: { url: string }): Promise<MoodleTab[]>;
		create(properties: { url: string; active: boolean }): Promise<unknown>;
		update(tabId: number, properties: { active: boolean }): Promise<unknown>;
		sendMessage(tabId: number, message: unknown): Promise<unknown>;
	};
}

export function createSyncNotificationId(
	mode: SyncNotificationReference["mode"],
	syncEventId: number,
): string {
	if (!Number.isSafeInteger(syncEventId) || syncEventId <= 0) {
		throw new RangeError("syncEventId must be a positive safe integer");
	}
	return `${SYNC_NOTIFICATION_ID_PREFIX}${mode}-${syncEventId}`;
}

export function parseSyncNotificationId(notificationId: string): SyncNotificationReference | null {
	const match = /^fuzzy-sync-(native)-([1-9]\d*)$/.exec(notificationId);
	if (!match) return null;
	const syncEventId = Number(match[2]);
	if (!Number.isSafeInteger(syncEventId)) return null;
	return { mode: match[1] as SyncNotificationReference["mode"], syncEventId };
}

export function createDeadlineScreenNavigation(
	syncEventId: number,
): DeadlineScreenNavigationMessage {
	if (!Number.isSafeInteger(syncEventId) || syncEventId <= 0) {
		throw new RangeError("syncEventId must be a positive safe integer");
	}
	return {
		type: SYNC_SCREEN_NAVIGATION_MESSAGE,
		screen: "deadlines",
		syncEventId,
	};
}

export function isDeadlineScreenNavigation(
	value: unknown,
): value is DeadlineScreenNavigationMessage {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<DeadlineScreenNavigationMessage>;
	return (
		candidate.type === SYNC_SCREEN_NAVIGATION_MESSAGE &&
		candidate.screen === "deadlines" &&
		Number.isSafeInteger(candidate.syncEventId) &&
		(candidate.syncEventId ?? 0) > 0
	);
}

export function syncEventChangeCursor(syncEventId: number): number {
	if (!Number.isSafeInteger(syncEventId) || syncEventId <= 0) {
		throw new RangeError("syncEventId must be a positive safe integer");
	}
	return syncEventId - 1;
}

export async function navigateFromSyncNotification(
	browserApi: SyncNavigationBrowser,
	notificationId: string,
): Promise<boolean> {
	const reference = parseSyncNotificationId(notificationId);
	if (!reference) return false;

	const navigation = createDeadlineScreenNavigation(reference.syncEventId);
	await browserApi.storage.local.set({
		[PENDING_SYNC_SCREEN_NAVIGATION_KEY]: navigation,
	});

	const tabs = await browserApi.tabs.query({ url: MOODLE_HTTPS_MATCH_PATTERN });
	const target = tabs.find((tab) => tab.active) ?? tabs[0];
	if (target?.id === undefined) {
		await browserApi.tabs.create({ url: MOODLE_HOME_URL, active: true });
		return true;
	}

	await browserApi.tabs.update(target.id, { active: true });
	const response = (await browserApi.tabs.sendMessage(target.id, navigation)) as
		| ScreenNavigationResponse
		| undefined;
	if (response?.handled) {
		await browserApi.storage.local.remove(PENDING_SYNC_SCREEN_NAVIGATION_KEY);
	}
	return true;
}
