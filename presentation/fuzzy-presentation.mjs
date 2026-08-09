import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const PRESENTATION_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(PRESENTATION_DIRECTORY, "..");
const WORK = path.join(PRESENTATION_DIRECTORY, "work");
const OUTPUT = path.join(PRESENTATION_DIRECTORY, "fuzzy-presentation.pptx");
const LOGO_PATH = path.join(ROOT, "apps", "extension", "public", "icon", "128.png");

const W = 1280;
const H = 720;
const M = 76;

const C = {
	dark: "#F7F4EE",
	darkSoft: "#E8F6F0",
	cream: "#F7F4EE",
	ink: "#17212B",
	muted: "#64707A",
	line: "#D7DDD8",
	green: "#10B897",
	greenSoft: "#DDF5ED",
	orange: "#F2A65A",
	white: "#FFFFFF",
};

const FONT = "Yu Gothic UI";

async function writeBlob(path, blob) {
	await fs.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
}

async function imageBytes(path) {
	const bytes = await fs.readFile(path);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function addText(slide, text, position, style = {}) {
	const shape = slide.shapes.add({
		geometry: "textbox",
		position,
		fill: "none",
		line: { style: "solid", fill: "none", width: 0 },
	});
	shape.text = text;
	shape.text.style = {
		fontFamily: FONT,
		fontSize: 20,
		color: C.ink,
		...style,
	};
	return shape;
}

function addRect(slide, position, fill, lineFill = fill, radius = "rounded-xl") {
	const config = {
		geometry: "roundRect",
		position,
		fill,
		line: { style: "solid", fill: lineFill, width: lineFill === "none" ? 0 : 1 },
	};
	if (radius) config.borderRadius = radius;
	return slide.shapes.add(config);
}

function addFooter() {
	// ページ番号は動画中の視線を散らすため表示しない。
}

function addTitle(slide, title, dark = false, kicker = "Fuzzy") {
	addText(
		slide,
		kicker.toUpperCase(),
		{ left: M, top: 54, width: 220, height: 22 },
		{ fontSize: 13, bold: true, color: dark ? C.green : C.green, letterSpacing: 1.6 },
	);
	addText(
		slide,
		title,
		{ left: M, top: 92, width: 1080, height: 82 },
		{ fontSize: 38, bold: true, color: C.ink, lineSpacing: 1.05 },
	);
	addRect(slide, { left: M, top: 188, width: 72, height: 4 }, C.green, C.green, null);
}

function addNote(slide, time, narration, sources) {
	slide.speakerNotes.textFrame.setText(
		`目安: ${time}\n\nナレーション:\n${narration}\n\n[Sources]\n${sources.join("\n")}\n[/Sources]`,
	);
	slide.speakerNotes.setVisible(true);
}

async function build() {
	await fs.mkdir(WORK, { recursive: true });
	const logo = await imageBytes(LOGO_PATH);
	const presentation = Presentation.create({ slideSize: { width: W, height: H } });

	// 1. Title
	{
		const slide = presentation.slides.add();
		slide.background.fill = C.dark;
		slide.images.add({
			blob: logo,
			contentType: "image/png",
			alt: "Fuzzy logo",
			fit: "contain",
			position: { left: M, top: 86, width: 86, height: 86 },
		});
		addText(
			slide,
			"Fuzzy",
			{ left: 182, top: 104, width: 280, height: 58 },
			{
				fontSize: 35,
				bold: true,
				color: C.ink,
			},
		);
		addText(
			slide,
			"資料を探す時間を、\n学ぶ時間へ。",
			{ left: M, top: 236, width: 760, height: 170 },
			{
				fontSize: 58,
				bold: true,
				color: C.ink,
				lineSpacing: 1.02,
			},
		);
		addText(
			slide,
			"Moodleの資料と課題を、ひとつの流れに。",
			{ left: M, top: 458, width: 700, height: 42 },
			{
				fontSize: 24,
				color: C.muted,
			},
		);
		addText(
			slide,
			"アプリデザイン総合演習",
			{ left: M, top: 624, width: 280, height: 26 },
			{
				fontSize: 14,
				bold: true,
				color: C.green,
				letterSpacing: 1.3,
			},
		);
		addFooter(slide, 1, true);
		addNote(
			slide,
			"0:00–0:15",
			"大学生活で増えていく資料や課題を、Fuzzyがひとつの流れにまとめます。",
			[
				"Fuzzy project: docs/仕様書.md",
				"Moodle発表課題の指示（ユーザー提供資料、2026-08-01）",
			],
		);
	}

	// 2. Moodle context
	{
		const slide = presentation.slides.add();
		slide.background.fill = C.cream;
		addTitle(slide, "Moodleには、授業に必要な情報が集まる");
		addText(
			slide,
			"授業ページを開けば、資料・課題・締切を確認できます。",
			{ left: M, top: 190, width: 760, height: 38 },
			{
				fontSize: 23,
				color: C.muted,
			},
		);
		addText(
			slide,
			"資料",
			{ left: 112, top: 310, width: 230, height: 72 },
			{ fontSize: 48, bold: true, color: C.ink },
		);
		addText(
			slide,
			"→",
			{ left: 365, top: 318, width: 70, height: 62 },
			{ fontSize: 42, bold: true, color: C.green, alignment: "center" },
		);
		addText(
			slide,
			"課題",
			{ left: 470, top: 310, width: 230, height: 72 },
			{ fontSize: 48, bold: true, color: C.ink },
		);
		addText(
			slide,
			"→",
			{ left: 723, top: 318, width: 70, height: 62 },
			{ fontSize: 42, bold: true, color: C.green, alignment: "center" },
		);
		addText(
			slide,
			"締切",
			{ left: 828, top: 310, width: 230, height: 72 },
			{ fontSize: 48, bold: true, color: C.ink },
		);
		addText(
			slide,
			"便利な入口があっても、整理は自分で続ける必要があります。",
			{ left: M, top: 490, width: 920, height: 40 },
			{
				fontSize: 24,
				bold: true,
				color: C.ink,
			},
		);
		addFooter(slide, 2);
		addNote(
			slide,
			"0:15–0:35",
			"Moodleは大学の授業ページです。資料、課題、締切を確認できますが、保存場所や整理方法は自分で考える必要があります。",
			[
				"Moodle発表課題の指示（ユーザー提供資料、2026-08-01）",
				"Fuzzy project: docs/仕様書.md",
			],
		);
	}

	// 3. Problem
	{
		const slide = presentation.slides.add();
		slide.background.fill = C.cream;
		addTitle(slide, "資料を受け取ったあと、迷いが増える");
		addText(
			slide,
			"必要な資料は、どこ？",
			{ left: M, top: 270, width: 760, height: 86 },
			{
				fontSize: 48,
				bold: true,
				color: C.ink,
			},
		);
		addText(
			slide,
			"保存場所と締切を、毎回探している。",
			{ left: M, top: 410, width: 760, height: 42 },
			{
				fontSize: 27,
				color: C.muted,
			},
		);
		addText(
			slide,
			"整理は、あと回しになりやすい。",
			{ left: M, top: 548, width: 680, height: 38 },
			{
				fontSize: 24,
				bold: true,
				color: C.green,
			},
		);
		addFooter(slide, 3, true);
		addNote(
			slide,
			"0:35–0:55",
			"資料を受け取るたびに、保存場所や締切を探すことになります。整理はつい後回しになります。",
			["一般的な利用場面としての整理（新規の事実データではありません）"],
		);
	}

	// 4. Save path
	{
		const slide = presentation.slides.add();
		slide.background.fill = C.cream;
		addTitle(slide, "Fuzzyは、保存の時点で迷いを減らす");
		addText(
			slide,
			"資料を受け取る瞬間に、整理のきっかけをつくります。",
			{ left: M, top: 190, width: 780, height: 38 },
			{
				fontSize: 23,
				color: C.muted,
			},
		);
		addRect(
			slide,
			{ left: 94, top: 300, width: 1092, height: 120 },
			C.white,
			C.line,
			"rounded-2xl",
		);
		addText(
			slide,
			"アプリデザイン総合演習",
			{ left: 130, top: 326, width: 360, height: 44 },
			{ fontSize: 25, bold: true, color: C.ink },
		);
		addText(
			slide,
			"→",
			{ left: 510, top: 322, width: 55, height: 48 },
			{ fontSize: 30, bold: true, color: C.green, alignment: "center" },
		);
		addText(
			slide,
			"第10回",
			{ left: 590, top: 326, width: 180, height: 44 },
			{ fontSize: 25, bold: true, color: C.ink },
		);
		addText(
			slide,
			"→",
			{ left: 788, top: 322, width: 55, height: 48 },
			{ fontSize: 30, bold: true, color: C.green, alignment: "center" },
		);
		addText(
			slide,
			"制作資料",
			{ left: 865, top: 326, width: 200, height: 44 },
			{ fontSize: 25, bold: true, color: C.ink },
		);
		addText(
			slide,
			"提案を見て、選んで保存。",
			{ left: M, top: 506, width: 610, height: 48 },
			{ fontSize: 32, bold: true, color: C.green },
		);
		addText(
			slide,
			"自分で決めた保存先だから、次からも続けやすい。",
			{ left: M, top: 564, width: 770, height: 34 },
			{ fontSize: 22, color: C.muted },
		);
		addFooter(slide, 4);
		addNote(
			slide,
			"0:55–1:35",
			"資料を保存するとき、Fuzzyは授業や回に合わせた保存先を提案します。ユーザーは内容を確認して、自分で保存先を選びます。",
			[
				"Fuzzy project: docs/仕様書.md",
				"Fuzzy save UI: apps/extension/src/entrypoints/content/savePanel.ts",
			],
		);
	}

	// 5. Search
	{
		const slide = presentation.slides.add();
		slide.background.fill = C.greenSoft;
		addTitle(slide, "必要な資料は、中身から見つかる");
		addText(
			slide,
			"ファイル名を思い出せなくても、覚えている言葉から探せます。",
			{ left: M, top: 190, width: 900, height: 38 },
			{
				fontSize: 23,
				color: C.muted,
			},
		);
		addRect(slide, { left: 90, top: 286, width: 300, height: 92 }, C.white, C.white, "rounded-2xl");
		addText(
			slide,
			"正規化",
			{ left: 132, top: 311, width: 200, height: 44 },
			{ fontSize: 32, bold: true, color: C.ink },
		);
		addText(
			slide,
			"→",
			{ left: 420, top: 303, width: 80, height: 62 },
			{ fontSize: 42, bold: true, color: C.green, alignment: "center" },
		);
		addRect(
			slide,
			{ left: 550, top: 248, width: 620, height: 180 },
			C.white,
			C.line,
			"rounded-2xl",
		);
		addText(
			slide,
			"第4回_正規化.pdf",
			{ left: 586, top: 278, width: 330, height: 32 },
			{ fontSize: 23, bold: true, color: C.ink },
		);
		addText(
			slide,
			"データベース  /  p.12",
			{ left: 586, top: 322, width: 320, height: 28 },
			{ fontSize: 18, color: C.green },
		);
		addText(
			slide,
			"…第3正規化の条件は、推移的関数従属が存在しないこと…",
			{ left: 586, top: 360, width: 520, height: 40 },
			{ fontSize: 16, color: C.muted },
		);
		addText(
			slide,
			"探す時間を、理解する時間へ。",
			{ left: M, top: 536, width: 650, height: 48 },
			{ fontSize: 32, bold: true, color: C.ink },
		);
		addFooter(slide, 5);
		addNote(
			slide,
			"1:35–2:15",
			"保存した資料は、ファイル名だけでなく中身からも探せます。必要な箇所とページが分かるので、資料を一つずつ開く時間を減らせます。",
			[
				"Fuzzy project: docs/仕様書.md",
				"Sample search data: packages/shared/src/sample-data/search-results.json",
			],
		);
	}

	// 6. Deadlines
	{
		const slide = presentation.slides.add();
		slide.background.fill = C.cream;
		addTitle(slide, "締切は、ひとつの流れで確認できる");
		addText(
			slide,
			"授業ごとに散らばる課題を、今日やることとして見渡せます。",
			{ left: M, top: 190, width: 900, height: 38 },
			{
				fontSize: 23,
				color: C.muted,
			},
		);
		addRect(
			slide,
			{ left: 90, top: 280, width: 1090, height: 245 },
			C.greenSoft,
			C.greenSoft,
			"rounded-2xl",
		);
		addText(
			slide,
			"次に確認する課題",
			{ left: 130, top: 318, width: 300, height: 28 },
			{ fontSize: 18, bold: true, color: C.green },
		);
		addText(
			slide,
			"正規化レポート提出",
			{ left: 130, top: 355, width: 600, height: 56 },
			{ fontSize: 36, bold: true, color: C.ink },
		);
		addText(
			slide,
			"データベース  /  7月4日 23:59",
			{ left: 130, top: 420, width: 520, height: 32 },
			{ fontSize: 21, color: C.muted },
		);
		addText(
			slide,
			"未提出",
			{ left: 930, top: 360, width: 180, height: 42 },
			{ fontSize: 28, bold: true, color: C.orange, alignment: "center" },
		);
		addText(
			slide,
			"他の授業の課題も、同じ画面で確認できます。",
			{ left: M, top: 570, width: 780, height: 32 },
			{ fontSize: 21, color: C.muted },
		);
		addFooter(slide, 6, true);
		addNote(
			slide,
			"2:15–2:55",
			"たとえば、次に確認する課題と締切がすぐに分かります。他の授業の課題も同じ画面で見渡せるので、次の行動に移りやすくなります。",
			[
				"Fuzzy project: docs/仕様書.md",
				"Sample deadline data: packages/shared/src/sample-data/deadlines.json",
			],
		);
	}

	// 7. User agency / organizing nudge
	{
		const slide = presentation.slides.add();
		slide.background.fill = C.cream;
		addTitle(slide, "Fuzzyは、整理を代わりに終わらせない");
		addText(
			slide,
			"便利にするだけではなく、整理を続けるきっかけを残します。",
			{ left: M, top: 190, width: 920, height: 38 },
			{
				fontSize: 23,
				color: C.muted,
			},
		);
		addText(
			slide,
			"提案する",
			{ left: 112, top: 324, width: 250, height: 58 },
			{ fontSize: 34, bold: true, color: C.green },
		);
		addText(
			slide,
			"→",
			{ left: 390, top: 316, width: 80, height: 66 },
			{ fontSize: 44, bold: true, color: C.ink, alignment: "center" },
		);
		addText(
			slide,
			"確認する",
			{ left: 510, top: 324, width: 250, height: 58 },
			{ fontSize: 34, bold: true, color: C.green },
		);
		addText(
			slide,
			"→",
			{ left: 788, top: 316, width: 80, height: 66 },
			{ fontSize: 44, bold: true, color: C.ink, alignment: "center" },
		);
		addText(
			slide,
			"選ぶ",
			{ left: 910, top: 324, width: 220, height: 58 },
			{ fontSize: 34, bold: true, color: C.orange },
		);
		addText(
			slide,
			"整理方法から外れた資料は知らせる。\n最後に決めるのは、ユーザー。",
			{ left: 112, top: 474, width: 820, height: 76 },
			{
				fontSize: 26,
				bold: true,
				color: C.ink,
				lineSpacing: 1.1,
			},
		);
		addFooter(slide, 7);
		addNote(
			slide,
			"2:55–3:25",
			"Fuzzyは、何でも自動で片付けるアプリではありません。整理方法から外れた資料は知らせますが、保存先を決めるのはユーザーです。整理を続けるためのきっかけを残します。",
			[
				"Fuzzy project: docs/仕様書.md",
				"Moodle発表課題の指示（ユーザー提供資料、2026-08-01）",
			],
		);
	}

	// 8. Outcome
	{
		const slide = presentation.slides.add();
		slide.background.fill = C.greenSoft;
		addTitle(slide, "整理が続くと、次の行動が見えてくる");
		addText(
			slide,
			"見つかる",
			{ left: 130, top: 300, width: 250, height: 56 },
			{ fontSize: 36, bold: true, color: C.ink },
		);
		addText(
			slide,
			"→",
			{ left: 390, top: 300, width: 72, height: 56 },
			{ fontSize: 38, bold: true, color: C.green, alignment: "center" },
		);
		addText(
			slide,
			"確認できる",
			{ left: 490, top: 300, width: 270, height: 56 },
			{ fontSize: 36, bold: true, color: C.ink },
		);
		addText(
			slide,
			"→",
			{ left: 770, top: 300, width: 72, height: 56 },
			{ fontSize: 38, bold: true, color: C.green, alignment: "center" },
		);
		addText(
			slide,
			"戻れる",
			{ left: 940, top: 300, width: 220, height: 56 },
			{ fontSize: 36, bold: true, color: C.orange },
		);
		addText(
			slide,
			"資料を探す時間を減らし、学習や制作に戻る。",
			{ left: M, top: 478, width: 930, height: 52 },
			{ fontSize: 31, bold: true, color: C.ink },
		);
		addFooter(slide, 8);
		addNote(
			slide,
			"3:25–3:45",
			"必要な資料が見つかり、締切が確認でき、整理した状態で学習や制作に戻れます。",
			["Fuzzy project: docs/仕様書.md"],
		);
	}

	// 9. Closing
	{
		const slide = presentation.slides.add();
		slide.background.fill = C.dark;
		slide.images.add({
			blob: logo,
			contentType: "image/png",
			alt: "Fuzzy logo",
			fit: "contain",
			position: { left: 568, top: 104, width: 144, height: 144 },
		});
		addText(
			slide,
			"Fuzzy",
			{ left: 450, top: 272, width: 380, height: 60 },
			{ fontSize: 48, bold: true, color: C.ink, alignment: "center" },
		);
		addText(
			slide,
			"Moodleの資料と課題を、\nひとつの流れに。",
			{ left: 290, top: 368, width: 700, height: 110 },
			{
				fontSize: 38,
				bold: true,
				color: C.ink,
				alignment: "center",
				lineSpacing: 1.05,
			},
		);
		addText(
			slide,
			"資料を探す時間を、学ぶ時間へ。",
			{ left: 340, top: 546, width: 600, height: 36 },
			{ fontSize: 23, color: C.green, alignment: "center" },
		);
		addText(
			slide,
			"アプリデザイン総合演習",
			{ left: 500, top: 624, width: 280, height: 24 },
			{ fontSize: 13, bold: true, color: C.muted, alignment: "center", letterSpacing: 1.4 },
		);
		addFooter(slide, 9, true);
		addNote(slide, "3:45–4:00", "Fuzzyは、資料を探す時間を減らし、学ぶ時間をつくるアプリです。", [
			"Fuzzy project: docs/仕様書.md",
			"Moodle発表課題の指示（ユーザー提供資料、2026-08-01）",
		]);
	}

	for (const [index, slide] of presentation.slides.items.entries()) {
		const stem = `slide-${String(index + 1).padStart(2, "0")}`;
		await writeBlob(
			`${WORK}/${stem}.png`,
			await presentation.export({ slide, format: "png", scale: 1 }),
		);
		await fs.writeFile(
			`${WORK}/${stem}.layout.json`,
			await (await slide.export({ format: "layout" })).text(),
		);
	}
	await writeBlob(
		`${WORK}/montage.webp`,
		await presentation.export({ format: "webp", montage: true, scale: 1 }),
	);
	const pptx = await PresentationFile.exportPptx(presentation);
	await pptx.save(OUTPUT);
	console.log(`Wrote ${OUTPUT}`);
}

build().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
