import { describe, expect, test } from "bun:test";
import {
	FUZZY_QA_MOODLE_HTTPS_MATCH_PATTERN,
	MOODLE_HTTPS_MATCH_PATTERNS,
	WAKAYAMA_MOODLE_HTTPS_MATCH_PATTERN,
	isSupportedMoodleAssignmentUrl,
	isSupportedMoodleHostname,
} from "../../apps/extension/moodleSite";

describe("対応Moodleホスト", () => {
	test("和歌山大学Moodleと審査用MoodleCloudだけを許可する", () => {
		expect(MOODLE_HTTPS_MATCH_PATTERNS).toEqual([
			WAKAYAMA_MOODLE_HTTPS_MATCH_PATTERN,
			FUZZY_QA_MOODLE_HTTPS_MATCH_PATTERN,
		]);
		expect(isSupportedMoodleHostname("moodle.wakayama-u.ac.jp")).toBe(true);
		expect(isSupportedMoodleHostname("moodle2026.wakayama-u.ac.jp")).toBe(true);
		expect(isSupportedMoodleHostname("fuzzy-qa-2026.moodlecloud.com")).toBe(true);
		expect(isSupportedMoodleHostname("other.moodlecloud.com")).toBe(false);
		expect(isSupportedMoodleHostname("www.wakayama-u.ac.jp")).toBe(false);
	});

	test("対応ホスト上の課題・小テストURLだけを許可する", () => {
		expect(
			isSupportedMoodleAssignmentUrl(
				"https://fuzzy-qa-2026.moodlecloud.com/mod/assign/view.php?id=701",
			),
		).toBe(true);
		expect(
			isSupportedMoodleAssignmentUrl(
				"https://moodle2026.wakayama-u.ac.jp/mod/quiz/view.php?id=702",
			),
		).toBe(true);
		expect(
			isSupportedMoodleAssignmentUrl("https://other.moodlecloud.com/mod/assign/view.php?id=701"),
		).toBe(false);
		expect(
			isSupportedMoodleAssignmentUrl(
				"http://fuzzy-qa-2026.moodlecloud.com/mod/assign/view.php?id=701",
			),
		).toBe(false);
	});
});
