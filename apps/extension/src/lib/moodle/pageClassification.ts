const UNIVERSITY_LOGIN_PATH = /^\/(?:\d{4}\/)?auth\/oidc\/?$/i;
const MOODLE_LOGIN_PATH = /^\/(?:\d{4}\/)?login\/index(?:_form)?\.(?:html|php)\/?$/i;
const MOODLE_LOGOUT_PATH = /^\/(?:\d{4}\/)?login\/logout\.php\/?$/i;
const MOODLE_LANDING_PATH = /^\/(?:\d{4}\/)?$/;

export type MoodlePageKind =
	| "authenticated"
	| "login"
	| "authentication-transition"
	| "logout-transition"
	| "unauthenticated"
	| "unavailable";

export type MoodleUiMode = "full" | "shell-only" | "none";

/** URLとMoodleの認証マーカーだけを使い、起動時のページ種別を決める。 */
export function classifyMoodlePage(document: Document, pageUrl: string): MoodlePageKind {
	const page = safeUrl(pageUrl);
	if (page && MOODLE_LOGOUT_PATH.test(page.pathname)) return "logout-transition";
	if (page && UNIVERSITY_LOGIN_PATH.test(page.pathname)) return "authentication-transition";
	if (isAuthenticatedMoodleDocument(document, pageUrl)) return "authenticated";

	const loginLinks = findUniversityLoginLinks(document, pageUrl);
	if (isMoodleLoginDocument(document, pageUrl, loginLinks.length > 0)) return "login";
	if (document.body?.classList.contains("notloggedin")) return "unauthenticated";
	return "unavailable";
}

/** 認証済み画面は全機能、Moodle障害HTMLはキャッシュ表示用シェルだけを起動する。 */
export function resolveMoodleUiMode(pageKind: MoodlePageKind): MoodleUiMode {
	if (pageKind === "authenticated") return "full";
	if (pageKind === "unavailable") return "shell-only";
	return "none";
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

export function isAuthenticatedMoodleDocument(document: Document, pageUrl: string): boolean {
	const page = safeUrl(pageUrl);
	if (page && MOODLE_LOGOUT_PATH.test(page.pathname)) return false;
	if (document.body?.classList.contains("loggedin")) return true;
	return Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).some((link) =>
		isMoodleLogoutUrl(link.getAttribute("href"), pageUrl),
	);
}

export function findUniversityLoginLinks(document: Document, pageUrl: string): HTMLAnchorElement[] {
	return Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).filter((link) => {
		const candidate = resolveSameOriginUrl(link.getAttribute("href"), pageUrl);
		return (
			candidate !== null &&
			UNIVERSITY_LOGIN_PATH.test(candidate.pathname) &&
			isUniversityLoginLinkText(link.textContent ?? "")
		);
	});
}

export function uniqueUniversityLoginLink(
	links: HTMLAnchorElement[],
	pageUrl: string,
): HTMLAnchorElement | null {
	const byUrl = new Map<string, HTMLAnchorElement>();
	for (const link of links) {
		const url = resolveSameOriginUrl(link.getAttribute("href"), pageUrl);
		if (url) byUrl.set(url.href, link);
	}
	return byUrl.size === 1 ? (byUrl.values().next().value ?? null) : null;
}

export function isUniversityAuthenticationPath(pageUrl: string): boolean {
	const page = safeUrl(pageUrl);
	return page !== null && UNIVERSITY_LOGIN_PATH.test(page.pathname);
}

export function isMoodleLoginPath(pageUrl: string): boolean {
	const page = safeUrl(pageUrl);
	return page !== null && MOODLE_LOGIN_PATH.test(page.pathname);
}

export function isMoodleLogoutPath(pageUrl: string): boolean {
	const page = safeUrl(pageUrl);
	return page !== null && MOODLE_LOGOUT_PATH.test(page.pathname);
}

export function resolveMoodleLogoutUrl(href: string | null, pageUrl: string): URL | null {
	const candidate = resolveSameOriginUrl(href, pageUrl);
	return candidate !== null && MOODLE_LOGOUT_PATH.test(candidate.pathname) ? candidate : null;
}

function isMoodleLogoutUrl(href: string | null, pageUrl: string): boolean {
	return resolveMoodleLogoutUrl(href, pageUrl) !== null;
}

function isUniversityLoginLinkText(text: string): boolean {
	const normalized = text.normalize("NFKC").replace(/\s+/g, "");
	const hasAccountSuffix = normalized.includes("@wakayama-u.ac.jp");
	const japaneseLabel = normalized.includes("和歌山大学ID") && normalized.includes("ログイン");
	const englishLabel = /wakayamauniversity/i.test(normalized) && /(?:log|sign)in/i.test(normalized);
	return hasAccountSuffix && (japaneseLabel || englishLabel);
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
