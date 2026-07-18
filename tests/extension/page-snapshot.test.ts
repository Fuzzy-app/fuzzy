import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
	extractFileLinks,
	resolveMoodleActivityMimeHint,
} from "../../apps/extension/src/lib/moodle/pageSnapshot";

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

	test("周辺の説明文だけではresourceページをファイルと誤判定しない", () => {
		const { document } = parseHTML(`
			<main>
				<div class="activity-item">
					<a href="https://moodle.example/mod/resource/view.php?id=1">Wordで開く資料の説明</a>
				</div>
			</main>
		`);
		expect(extractFileLinks(document)).toHaveLength(0);
	});

	test("構造化MIME属性があるresourceページだけを資料として抽出する", () => {
		const { document } = parseHTML(`
			<main>
				<div class="activity-item">
					<img data-mimetype="application/pdf" />
					<a href="https://moodle.example/mod/resource/view.php?id=2">第4回 正規化</a>
				</div>
			</main>
		`);
		const files = extractFileLinks(document);
		expect(files).toHaveLength(1);
		expect(files[0]?.mimeHint).toBe("pdf");
		expect(files[0]?.title).toBe("第4回 正規化.pdf");
	});
});
