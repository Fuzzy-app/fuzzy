import { type SavePanelStateStorage, resetSavePanelOpenState } from "./savePanelState";

export const AUTOMATIC_LOGIN_ATTEMPT_SESSION_KEY = "fuzzy:automaticLoginAttempted";
export const EXPLICIT_LOGOUT_STORAGE_KEY = "fuzzy:explicitLogout";
export const EXPLICIT_LOGOUT_SESSION_KEY = "fuzzy:explicitLogoutToken";

const UNIVERSITY_LOGIN_PATH = /^\/(?:\d{4}\/)?auth\/oidc\/?$/i;
const MOODLE_LOGIN_PATH = /^\/(?:\d{4}\/)?login\/index(?:_form)?\.(?:html|php)\/?$/i;
const MOODLE_LOGOUT_PATH = /^\/(?:\d{4}\/)?login\/logout\.php\/?$/i;
const MOODLE_LANDING_PATH = /^\/(?:\d{4}\/)?$/;

export interface LoginAutomationSessionStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

interface LoginAutomationOptions {
	document: Document;
	pageUrl: string;
	panelStateStorage: SavePanelStateStorage;
	sessionStorage: LoginAutomationSessionStorage;
	onError?: (error: unknown) => void;
}

interface LogoutTrackingOptions {
	document: Document;
	pageUrl: string;
	panelStateStorage: SavePanelStateStorage;
	sessionStorage: LoginAutomationSessionStorage;
	navigate?: (url: string) => void;
	createLogoutToken?: () => string;
	onError?: (error: unknown) => void;
}

export type MoodleLoginPageResult =
	| "not-login-page"
	| "automatic-login-started"
	| "automatic-login-suppressed"
	| "manual-login"
	| "state-reset-failed"
	| "authentication-transition"
	| "logout-transition";

/**
 * Moodleのログイン入口だけを処理する。
 * 認証情報には触れず、保存パネルを閉じる状態へ更新できた場合だけ大学認証へ進む。
 */
export async function handleMoodleLoginPage(
	options: LoginAutomationOptions,
): Promise<MoodleLoginPageResult> {
	const onError = options.onError ?? defaultLoginAutomationErrorHandler;
	const page = safeUrl(options.pageUrl);
	if (page && MOODLE_LOGOUT_PATH.test(page.pathname)) return "logout-transition";
	if (page && UNIVERSITY_LOGIN_PATH.test(page.pathname)) {
		const resetSucceeded = await resetSavePanelOpenState(options.panelStateStorage, onError);
		return resetSucceeded ? "authentication-transition" : "state-reset-failed";
	}
	if (isAuthenticatedMoodleDocument(options.document, options.pageUrl)) {
		return "not-login-page";
	}

	const loginLinks = findUniversityLoginLinks(options.document, options.pageUrl);
	if (!isMoodleLoginDocument(options.document, options.pageUrl, loginLinks.length > 0)) {
		return "not-login-page";
	}

	const resetSucceeded = await resetSavePanelOpenState(options.panelStateStorage, onError);
	if (!resetSucceeded) return "state-reset-failed";

	const loginLink = uniqueLoginLink(loginLinks, options.pageUrl);
	if (!loginLink) return "manual-login";

	const persistentLogoutToken = await readPersistentLogoutToken(options.panelStateStorage, onError);
	const sessionLogoutToken = readSessionValue(
		options.sessionStorage,
		EXPLICIT_LOGOUT_SESSION_KEY,
		onError,
	);
	if (persistentLogoutToken === undefined || sessionLogoutToken === undefined) {
		return "automatic-login-suppressed";
	}
	if (persistentLogoutToken !== null) {
		if (sessionLogoutToken === null) {
			writeSessionValue(
				options.sessionStorage,
				EXPLICIT_LOGOUT_SESSION_KEY,
				persistentLogoutToken,
				onError,
			);
		}
		return "automatic-login-suppressed";
	}
	if (
		sessionLogoutToken !== null ||
		readSessionFlag(options.sessionStorage, AUTOMATIC_LOGIN_ATTEMPT_SESSION_KEY, onError)
	) {
		return "automatic-login-suppressed";
	}

	if (!writeSessionFlag(options.sessionStorage, AUTOMATIC_LOGIN_ATTEMPT_SESSION_KEY, onError)) {
		return "automatic-login-suppressed";
	}

	loginLink.click();
	return "automatic-login-started";
}

/**
 * 明示ログアウトを拡張機能全体で記録し、別タブからの即時再ログインも抑止する。
 * ログイン済みページへ戻ったことを確認できた場合だけ抑止状態を解除する。
 */
export async function setupMoodleLogoutTracking(options: LogoutTrackingOptions): Promise<void> {
	const onError = options.onError ?? defaultLoginAutomationErrorHandler;
	const page = safeUrl(options.pageUrl);
	let logoutPending = false;
	let authenticatedCleanup = Promise.resolve();
	let authenticatedCleanupPending = false;
	const createLogoutToken = options.createLogoutToken ?? defaultLogoutToken;
	options.document.addEventListener(
		"click",
		(event) => {
			const link = closestLink(event.target);
			const logoutUrl = resolveMoodleLogoutUrl(link?.getAttribute("href") ?? null, options.pageUrl);
			if (!logoutUrl || !isUnmodifiedPrimaryClick(event) || logoutPending) return;

			event.preventDefault();
			event.stopImmediatePropagation();
			logoutPending = true;
			const logoutToken = createLogoutToken();
			rememberExplicitLogoutInSession(options.sessionStorage, logoutToken, onError);
			const navigate = options.navigate ?? ((url: string) => window.location.assign(url));
			const initialWrite = writePersistentLogoutToken(
				options.panelStateStorage,
				logoutToken,
				onError,
			);
			// 解除処理と重なった場合は、その完了後にも新しいログアウト状態を再確定する。
			if (authenticatedCleanupPending) {
				void authenticatedCleanup.finally(async () => {
					await initialWrite;
					await writePersistentLogoutToken(options.panelStateStorage, logoutToken, onError);
				});
			}
			navigate(logoutUrl.href);
		},
		true,
	);

	if (page && MOODLE_LOGOUT_PATH.test(page.pathname)) {
		const logoutToken = createLogoutToken();
		rememberExplicitLogoutInSession(options.sessionStorage, logoutToken, onError);
		void writePersistentLogoutToken(options.panelStateStorage, logoutToken, onError);
		return;
	}
	if (
		page &&
		(UNIVERSITY_LOGIN_PATH.test(page.pathname) || MOODLE_LOGIN_PATH.test(page.pathname))
	) {
		return;
	}

	if (isAuthenticatedMoodleDocument(options.document, options.pageUrl)) {
		removeSessionFlag(options.sessionStorage, AUTOMATIC_LOGIN_ATTEMPT_SESSION_KEY, onError);
		authenticatedCleanupPending = true;
		authenticatedCleanup = clearCompletedExplicitLogout(
			options.panelStateStorage,
			options.sessionStorage,
			() => logoutPending,
			onError,
		);
		try {
			await authenticatedCleanup;
		} finally {
			authenticatedCleanupPending = false;
		}
	}
}

export function isMoodleLoginDocument(
	document: Document,
	pageUrl: string,
	hasUniversityLoginLink = findUniversityLoginLinks(document, pageUrl).length > 0,
): boolean {
	if (isAuthenticatedMoodleDocument(document, pageUrl)) return false;
	const page = safeUrl(pageUrl);
	const isKnownLoginPath = page !== null && MOODLE_LOGIN_PATH.test(page.pathname);
	const isLandingPath = page !== null && MOODLE_LANDING_PATH.test(page.pathname);
	const hasLoginForm =
		document.querySelector('form input[type="password"], form input[name="username"]') !== null;
	if (isKnownLoginPath) return true;
	return isLandingPath && (hasUniversityLoginLink || hasLoginForm);
}

function isAuthenticatedMoodleDocument(document: Document, pageUrl: string): boolean {
	const page = safeUrl(pageUrl);
	if (page && MOODLE_LOGOUT_PATH.test(page.pathname)) return false;
	if (document.body?.classList.contains("loggedin")) return true;
	return Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).some((link) =>
		isMoodleLogoutUrl(link.getAttribute("href"), pageUrl),
	);
}

function findUniversityLoginLinks(document: Document, pageUrl: string): HTMLAnchorElement[] {
	return Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).filter((link) => {
		const candidate = resolveSameOriginUrl(link.getAttribute("href"), pageUrl);
		return (
			candidate !== null &&
			UNIVERSITY_LOGIN_PATH.test(candidate.pathname) &&
			isUniversityLoginLinkText(link.textContent ?? "")
		);
	});
}

function isUniversityLoginLinkText(text: string): boolean {
	const normalized = text.normalize("NFKC").replace(/\s+/g, "");
	const hasAccountSuffix = normalized.includes("@wakayama-u.ac.jp");
	const japaneseLabel = normalized.includes("和歌山大学ID") && normalized.includes("ログイン");
	const englishLabel = /wakayamauniversity/i.test(normalized) && /(?:log|sign)in/i.test(normalized);
	return hasAccountSuffix && (japaneseLabel || englishLabel);
}

function uniqueLoginLink(links: HTMLAnchorElement[], pageUrl: string): HTMLAnchorElement | null {
	const byUrl = new Map<string, HTMLAnchorElement>();
	for (const link of links) {
		const url = resolveSameOriginUrl(link.getAttribute("href"), pageUrl);
		if (url) byUrl.set(url.href, link);
	}
	return byUrl.size === 1 ? (byUrl.values().next().value ?? null) : null;
}

function isMoodleLogoutUrl(href: string | null, pageUrl: string): boolean {
	return resolveMoodleLogoutUrl(href, pageUrl) !== null;
}

function resolveMoodleLogoutUrl(href: string | null, pageUrl: string): URL | null {
	const candidate = resolveSameOriginUrl(href, pageUrl);
	return candidate !== null && MOODLE_LOGOUT_PATH.test(candidate.pathname) ? candidate : null;
}

function resolveSameOriginUrl(href: string | null, pageUrl: string): URL | null {
	if (!href) return null;
	try {
		const page = new URL(pageUrl);
		const candidate = new URL(href, page);
		return candidate.protocol === "https:" && candidate.origin === page.origin ? candidate : null;
	} catch {
		return null;
	}
}

function safeUrl(value: string): URL | null {
	try {
		return new URL(value);
	} catch {
		return null;
	}
}

function closestLink(target: EventTarget | null): HTMLAnchorElement | null {
	const element = target as Element | null;
	if (!element || typeof element.closest !== "function") return null;
	return element.closest("a[href]") as HTMLAnchorElement | null;
}

function isUnmodifiedPrimaryClick(event: Event): boolean {
	const mouseEvent = event as MouseEvent;
	return (
		(mouseEvent.button === undefined || mouseEvent.button === 0) &&
		!mouseEvent.altKey &&
		!mouseEvent.ctrlKey &&
		!mouseEvent.metaKey &&
		!mouseEvent.shiftKey
	);
}

async function clearCompletedExplicitLogout(
	storage: SavePanelStateStorage,
	sessionStorage: LoginAutomationSessionStorage,
	shouldAbort: () => boolean,
	onError: (error: unknown) => void,
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
		removeSessionFlag(sessionStorage, EXPLICIT_LOGOUT_SESSION_KEY, onError);
	}
}

async function readPersistentLogoutToken(
	storage: SavePanelStateStorage,
	onError: (error: unknown) => void,
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

async function writePersistentLogoutToken(
	storage: SavePanelStateStorage,
	token: string | null,
	onError: (error: unknown) => void,
): Promise<boolean> {
	try {
		await storage.set({ [EXPLICIT_LOGOUT_STORAGE_KEY]: token ?? false });
		return true;
	} catch (error) {
		onError(error);
		return false;
	}
}

function rememberExplicitLogoutInSession(
	storage: LoginAutomationSessionStorage,
	logoutToken: string,
	onError: (error: unknown) => void,
): void {
	writeSessionValue(storage, EXPLICIT_LOGOUT_SESSION_KEY, logoutToken, onError);
	// 永続化に失敗しても、同じタブでは次のログイン画面で自動操作しない。
	writeSessionFlag(storage, AUTOMATIC_LOGIN_ATTEMPT_SESSION_KEY, onError);
}

function readSessionValue(
	storage: LoginAutomationSessionStorage,
	key: string,
	onError: (error: unknown) => void,
): string | null | undefined {
	try {
		const value = storage.getItem(key);
		return value && value.length > 0 ? value : null;
	} catch (error) {
		onError(error);
		return undefined;
	}
}

function writeSessionValue(
	storage: LoginAutomationSessionStorage,
	key: string,
	value: string,
	onError: (error: unknown) => void,
): boolean {
	try {
		storage.setItem(key, value);
		return true;
	} catch (error) {
		onError(error);
		return false;
	}
}

function readSessionFlag(
	storage: LoginAutomationSessionStorage,
	key: string,
	onError: (error: unknown) => void,
): boolean {
	try {
		return storage.getItem(key) === "true";
	} catch (error) {
		onError(error);
		return true;
	}
}

function writeSessionFlag(
	storage: LoginAutomationSessionStorage,
	key: string,
	onError: (error: unknown) => void,
): boolean {
	try {
		storage.setItem(key, "true");
		return true;
	} catch (error) {
		onError(error);
		return false;
	}
}

function removeSessionFlag(
	storage: LoginAutomationSessionStorage,
	key: string,
	onError: (error: unknown) => void,
): void {
	try {
		storage.removeItem(key);
	} catch (error) {
		onError(error);
	}
}

function defaultLogoutToken(): string {
	const randomPart =
		typeof globalThis.crypto?.randomUUID === "function"
			? globalThis.crypto.randomUUID()
			: Math.random().toString(36).slice(2);
	return `${Date.now().toString(36)}-${randomPart}`;
}

function defaultLoginAutomationErrorHandler(error: unknown): void {
	console.warn("[fuzzy] Moodleログイン補助の状態を更新できませんでした", error);
}
