export const MOODLE_HTTPS_MATCH_PATTERN = "https://*.wakayama-u.ac.jp/*";
export const MOODLE_HOME_URL = "https://moodle.wakayama-u.ac.jp/";

export function isSupportedMoodleAssignmentUrl(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 2_048) return false;
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			/^moodle\d*\.wakayama-u\.ac\.jp$/i.test(url.hostname) &&
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
