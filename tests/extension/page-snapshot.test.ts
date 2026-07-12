import { describe, expect, test } from "bun:test";
import { resolveMoodleActivityMimeHint } from "../../apps/extension/src/lib/moodle/pageSnapshot";

describe("resolveMoodleActivityMimeHint", () => {
	test("未認識のバッジでもMP3・EXEアイコンから種別を推定する", () => {
		expect(
			resolveMoodleActivityMimeHint(
				"ファイル",
				"https://moodle.example/theme/image.php/boost/core/1/f/mp3-24.png",
			),
		).toBe("mp3");
		expect(
			resolveMoodleActivityMimeHint(
				"リソース",
				"https://moodle.example/theme/image.php/boost/core/1/f/exe-24.png",
			),
		).toBe("exe");
	});

	test("HTMLアイコンはページリンク除外に使える種別として返す", () => {
		expect(
			resolveMoodleActivityMimeHint(
				"ファイル",
				"https://moodle.example/theme/image.php/boost/core/1/f/html-24.svg",
			),
		).toBe("html");
	});

	test("認識済みバッジはアイコンより優先する", () => {
		expect(
			resolveMoodleActivityMimeHint(
				"PDF",
				"https://moodle.example/theme/image.php/boost/core/1/f/exe-24.png",
			),
		).toBe("pdf");
	});
});
