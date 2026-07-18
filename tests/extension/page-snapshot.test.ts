import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
	extractFileLinks,
	resolveMoodleActivityMimeHint,
} from "../../apps/extension/src/lib/moodle/pageSnapshot";

describe("Moodle資料のDOM解析", () => {
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

	test("URL拡張子がある場合は周辺のバッジより優先する", () => {
		const { document } = parseHTML(`
			<main>
				<div class="activity-item">
					<span class="activitybadge">Word</span>
					<a href="https://moodle.example/pluginfile.php/10/file.pdf">Word版と比較するPDF</a>
				</div>
			</main>
		`);
		const files = extractFileLinks(document);
		expect(files).toHaveLength(1);
		expect(files[0]?.mimeHint).toBe("pdf");
	});

	test("活動名や容量ではなく親セクションの見出しを所属名にする", () => {
		const { document } = parseHTML(`
			<main class="course-content">
				<section data-sectionid="1">
					<h3 class="sectionname">第1回 画像処理</h3>
					<div class="activity" data-activityname="画像処理とは（7.6MB）">
						<a href="https://moodle.example/pluginfile.php/11/image.pdf">同名資料.pdf</a>
					</div>
				</section>
			</main>
		`);
		const files = extractFileLinks(document);
		expect(files[0]?.sectionTitle).toBe("第1回 画像処理");
	});

	test("親子関係のないテーマでも直前のセクション見出しを一度の走査で割り当てる", () => {
		const { document } = parseHTML(`
			<main class="course-content">
				<h3 class="section-title">1. ガイダンス</h3>
				<div class="activity"><a href="https://moodle.example/pluginfile.php/21/guide.pdf">資料.pdf</a></div>
				<h3 class="section-title">第2回 演習</h3>
				<div class="activity"><a href="https://moodle.example/pluginfile.php/22/guide.pdf">資料.pdf</a></div>
			</main>
		`);
		const files = extractFileLinks(document);
		expect(files.map((file) => file.sectionTitle)).toEqual(["1. ガイダンス", "第2回 演習"]);
	});

	test("セクションがない場合は活動名を所属名として流用しない", () => {
		const { document } = parseHTML(`
			<main>
				<h2>データベース</h2>
				<div class="activity" data-activityname="正規化資料（2.4MB）">
					<a href="https://moodle.example/pluginfile.php/31/normalization.pdf">正規化資料.pdf</a>
				</div>
			</main>
		`);
		const files = extractFileLinks(document);
		expect(files[0]?.sectionTitle).toBeNull();
	});
});
