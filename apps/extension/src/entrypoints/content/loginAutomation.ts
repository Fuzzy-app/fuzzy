import type { ExtensionStateErrorHandler } from "../../lib/extensionStateStorage";
import {
	AUTOMATIC_LOGIN_ATTEMPT_SESSION_KEY,
	EXPLICIT_LOGOUT_SESSION_KEY,
	EXPLICIT_LOGOUT_STORAGE_KEY,
	type LoginAutomationSessionStorage,
	clearCompletedExplicitLogout,
	createDefaultLogoutToken,
	getOrCreateExplicitLogoutToken,
	readPersistentLogoutToken,
	readSessionFlag,
	readSessionValue,
	rememberExplicitLogoutInSession,
	removeSessionValue,
	writePersistentLogoutToken,
	writeSessionFlag,
	writeSessionValue,
} from "../../lib/moodle/loginAutomationState";
import {
	findUniversityLoginLinks,
	isAuthenticatedMoodleDocument,
	isMoodleLoginDocument,
	isMoodleLoginPath,
	isMoodleLogoutPath,
	isUniversityAuthenticationPath,
	resolveMoodleLogoutUrl,
	uniqueUniversityLoginLink,
} from "../../lib/moodle/pageClassification";
import { type SavePanelStateStorage, requestSavePanelClosedOnNextMount } from "./savePanelState";

export {
	AUTOMATIC_LOGIN_ATTEMPT_SESSION_KEY,
	EXPLICIT_LOGOUT_SESSION_KEY,
	EXPLICIT_LOGOUT_STORAGE_KEY,
	type LoginAutomationSessionStorage,
	isMoodleLoginDocument,
};

interface LoginAutomationOptions {
	document: Document;
	pageUrl: string;
	panelStateStorage: SavePanelStateStorage;
	sessionStorage: LoginAutomationSessionStorage;
	onError?: ExtensionStateErrorHandler;
}

interface LogoutTrackingOptions {
	document: Document;
	pageUrl: string;
	panelStateStorage: SavePanelStateStorage;
	sessionStorage: LoginAutomationSessionStorage;
	navigate?: (url: string) => void;
	createLogoutToken?: () => string;
	onError?: ExtensionStateErrorHandler;
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
 * 認証情報には触れず、次回パネルを閉じる指示を保存できた場合だけ大学認証へ進む。
 */
export async function handleMoodleLoginPage(
	options: LoginAutomationOptions,
): Promise<MoodleLoginPageResult> {
	const onError = options.onError ?? defaultLoginAutomationErrorHandler;
	if (isMoodleLogoutPath(options.pageUrl)) return "logout-transition";
	if (isUniversityAuthenticationPath(options.pageUrl)) {
		const resetSucceeded = await requestSavePanelClosedOnNextMount(
			options.panelStateStorage,
			onError,
		);
		return resetSucceeded ? "authentication-transition" : "state-reset-failed";
	}
	if (isAuthenticatedMoodleDocument(options.document, options.pageUrl)) {
		return "not-login-page";
	}

	const loginLinks = findUniversityLoginLinks(options.document, options.pageUrl);
	if (!isMoodleLoginDocument(options.document, options.pageUrl, loginLinks.length > 0)) {
		return "not-login-page";
	}

	const resetSucceeded = await requestSavePanelClosedOnNextMount(
		options.panelStateStorage,
		onError,
	);
	if (!resetSucceeded) return "state-reset-failed";

	const loginLink = uniqueUniversityLoginLink(loginLinks, options.pageUrl);
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
 * 認証済みページのログアウト操作とログアウト遷移ページだけを追跡する。
 * 同じ遷移ではsessionStorage上の同一トークンを使い、非同期書き込み順に依存させない。
 */
export async function setupMoodleLogoutTracking(options: LogoutTrackingOptions): Promise<void> {
	const onError = options.onError ?? defaultLoginAutomationErrorHandler;
	let logoutPending = false;
	let authenticatedCleanup = Promise.resolve();
	let authenticatedCleanupPending = false;
	const createLogoutToken = options.createLogoutToken ?? createDefaultLogoutToken;

	if (isAuthenticatedMoodleDocument(options.document, options.pageUrl)) {
		options.document.addEventListener(
			"click",
			(event) => {
				const link = closestLink(event.target);
				const logoutUrl = resolveMoodleLogoutUrl(
					link?.getAttribute("href") ?? null,
					options.pageUrl,
				);
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
				// 認証完了時の解除と重なった場合だけ、解除後にも同じトークンを再確定する。
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
	}

	if (isMoodleLogoutPath(options.pageUrl)) {
		const logoutToken = getOrCreateExplicitLogoutToken(
			options.sessionStorage,
			createLogoutToken,
			onError,
		);
		rememberExplicitLogoutInSession(options.sessionStorage, logoutToken, onError);
		await writePersistentLogoutToken(options.panelStateStorage, logoutToken, onError);
		return;
	}
	if (
		isUniversityAuthenticationPath(options.pageUrl) ||
		isMoodleLoginPath(options.pageUrl) ||
		!isAuthenticatedMoodleDocument(options.document, options.pageUrl)
	) {
		return;
	}

	removeSessionValue(options.sessionStorage, AUTOMATIC_LOGIN_ATTEMPT_SESSION_KEY, onError);
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

function defaultLoginAutomationErrorHandler(error: unknown): void {
	console.warn("[fuzzy] Moodleログイン補助の状態を更新できませんでした", error);
}
