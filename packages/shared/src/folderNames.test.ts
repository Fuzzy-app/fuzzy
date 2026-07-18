import { describe, expect, test } from "bun:test";
import { courseFolderName, folderSegment } from "./folderNames";

describe("保存先フォルダ名の正規化", () => {
	test("半角・全角の丸括弧と角括弧、絵文字を除去する", () => {
		expect(folderSegment("情報科学📚（2026年度・前期）")).toBe("情報科学");
		expect(folderSegment("統計学 (担当: 山田)")).toBe("統計学");
		expect(folderSegment("英語［Aクラス］")).toBe("英語");
		expect(folderSegment("第4回[配布資料]🔬")).toBe("第4回");
		expect(folderSegment("プログラミング（演習[追加]）")).toBe("プログラミング");
	});

	test("閉じ括弧のない文字列は後続のコース名まで失わない", () => {
		expect(folderSegment("情報科学（前期")).toBe("情報科学(前期");
	});

	test("簡略化後に同名になるコースは安定IDで区別する", () => {
		const courses = [
			{ name: "英語（A）", stableId: "course-english-a" },
			{ name: "英語［B］", stableId: "course-english-b" },
		];
		const courseA = courseFolderName("英語（A）", courses);
		const courseB = courseFolderName("英語［B］", courses);

		expect(courseA).toBe("英語_course-english-a");
		expect(courseB).toBe("英語_course-english-b");
		expect(courseA).not.toBe(courseB);
		expect(`${courseA}${courseB}`).not.toMatch(/[()[\]（）［］\p{Extended_Pictographic}]/u);
	});
});
