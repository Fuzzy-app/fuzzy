export const WAKAYAMA_MOODLE_HTTPS_MATCH_PATTERN = "https://*.wakayama-u.ac.jp/*";
export const FUZZY_QA_MOODLE_HTTPS_MATCH_PATTERN = "https://fuzzy-qa-2026.moodlecloud.com/*";
export const MOODLE_HTTPS_MATCH_PATTERNS = [
	WAKAYAMA_MOODLE_HTTPS_MATCH_PATTERN,
	FUZZY_QA_MOODLE_HTTPS_MATCH_PATTERN,
];
export const MOODLE_HOME_URL = "https://moodle.wakayama-u.ac.jp/";

const WAKAYAMA_MOODLE_HOSTNAME = /^moodle\d*\.wakayama-u\.ac\.jp$/i;
const FUZZY_QA_MOODLE_HOSTNAME = "fuzzy-qa-2026.moodlecloud.com";

export function isSupportedMoodleHostname(value: unknown): value is string {
	return (
		typeof value === "string" &&
		(WAKAYAMA_MOODLE_HOSTNAME.test(value) || value.toLowerCase() === FUZZY_QA_MOODLE_HOSTNAME)
	);
}

export function isSupportedMoodleAssignmentUrl(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 2_048) return false;
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			isSupportedMoodleHostname(url.hostname) &&
			/^\/mod\/(?:assign|quiz)\/view\.php$/i.test(url.pathname) &&
			/^[A-Za-z0-9._:-]{1,128}$/.test(url.searchParams.get("id") ?? "") &&
			url.username === "" &&
			url.password === "" &&
			url.hash === ""
		);
	} catch {
		return false;
	}
}
