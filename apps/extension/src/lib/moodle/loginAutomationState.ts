import type { ExtensionStateErrorHandler, ExtensionStateStorage } from "../extensionStateStorage";

export const AUTOMATIC_LOGIN_ATTEMPT_SESSION_KEY = "fuzzy:automaticLoginAttempted";
export const EXPLICIT_LOGOUT_STORAGE_KEY = "fuzzy:explicitLogout";
export const EXPLICIT_LOGOUT_SESSION_KEY = "fuzzy:explicitLogoutToken";

export interface LoginAutomationSessionStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export async function readPersistentLogoutToken(
	storage: ExtensionStateStorage,
	onError: ExtensionStateErrorHandler,
): Promise<string | null | undefined> {
	try {
		const stored = await storage.get(EXPLICIT_LOGOUT_STORAGE_KEY);
		const value = stored[EXPLICIT_LOGOUT_STORAGE_KEY];
		if (typeof value === "string" && value.length > 0) return value;
		// 旧形式のtrueが残っていても安全側で抑止し、次の手動ログインで解除する。
		return value === true ? "legacy-explicit-logout" : null;
	} catch (error) {
		onError(error);
		return undefined;
	}
}

export async function writePersistentLogoutToken(
	storage: ExtensionStateStorage,
	token: string | null,
	onError: ExtensionStateErrorHandler,
): Promise<boolean> {
	try {
		await storage.set({ [EXPLICIT_LOGOUT_STORAGE_KEY]: token ?? false });
		return true;
	} catch (error) {
		onError(error);
		return false;
	}
}

/** 同一ログアウト遷移ではsessionStorage上のトークンを再利用する。 */
export function getOrCreateExplicitLogoutToken(
	storage: LoginAutomationSessionStorage,
	createToken: () => string,
	onError: ExtensionStateErrorHandler,
): string {
	return readSessionValue(storage, EXPLICIT_LOGOUT_SESSION_KEY, onError) ?? createToken();
}

export function rememberExplicitLogoutInSession(
	storage: LoginAutomationSessionStorage,
	logoutToken: string,
	onError: ExtensionStateErrorHandler,
): void {
	writeSessionValue(storage, EXPLICIT_LOGOUT_SESSION_KEY, logoutToken, onError);
	// 永続化に失敗しても、同じタブでは次のログイン画面で自動操作しない。
	writeSessionFlag(storage, AUTOMATIC_LOGIN_ATTEMPT_SESSION_KEY, onError);
}

export async function clearCompletedExplicitLogout(
	storage: ExtensionStateStorage,
	sessionStorage: LoginAutomationSessionStorage,
	shouldAbort: () => boolean,
	onError: ExtensionStateErrorHandler,
): Promise<void> {
	const completedToken = readSessionValue(sessionStorage, EXPLICIT_LOGOUT_SESSION_KEY, onError);
	if (!completedToken) return;

	const persistentToken = await readPersistentLogoutToken(storage, onError);
	if (persistentToken === undefined || shouldAbort()) return;
	if (
		persistentToken === completedToken &&
		!(await writePersistentLogoutToken(storage, null, onError))
	) {
		return;
	}

	// 読み書きの途中で新しいログアウトが始まった場合、その新しいトークンは消さない。
	if (
		!shouldAbort() &&
		readSessionValue(sessionStorage, EXPLICIT_LOGOUT_SESSION_KEY, onError) === completedToken
	) {
		removeSessionValue(sessionStorage, EXPLICIT_LOGOUT_SESSION_KEY, onError);
	}
}

export function readSessionValue(
	storage: LoginAutomationSessionStorage,
	key: string,
	onError: ExtensionStateErrorHandler,
): string | null | undefined {
	try {
		const value = storage.getItem(key);
		return value && value.length > 0 ? value : null;
	} catch (error) {
		onError(error);
		return undefined;
	}
}

export function writeSessionValue(
	storage: LoginAutomationSessionStorage,
	key: string,
	value: string,
	onError: ExtensionStateErrorHandler,
): boolean {
	try {
		storage.setItem(key, value);
		return true;
	} catch (error) {
		onError(error);
		return false;
	}
}

export function readSessionFlag(
	storage: LoginAutomationSessionStorage,
	key: string,
	onError: ExtensionStateErrorHandler,
): boolean {
	try {
		return storage.getItem(key) === "true";
	} catch (error) {
		onError(error);
		return true;
	}
}

export function writeSessionFlag(
	storage: LoginAutomationSessionStorage,
	key: string,
	onError: ExtensionStateErrorHandler,
): boolean {
	try {
		storage.setItem(key, "true");
		return true;
	} catch (error) {
		onError(error);
		return false;
	}
}

export function removeSessionValue(
	storage: LoginAutomationSessionStorage,
	key: string,
	onError: ExtensionStateErrorHandler,
): void {
	try {
		storage.removeItem(key);
	} catch (error) {
		onError(error);
	}
}

export function createDefaultLogoutToken(): string {
	const randomPart =
		typeof globalThis.crypto?.randomUUID === "function"
			? globalThis.crypto.randomUUID()
			: Math.random().toString(36).slice(2);
	return `${Date.now().toString(36)}-${randomPart}`;
}
