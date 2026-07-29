import { describe, expect, test } from "bun:test";
import {
	fileExtensionFromContentDisposition,
	fileExtensionFromName,
	fileNameFromContentDisposition,
	fileType,
	normalizeFileTypeHint,
} from "../../apps/extension/src/lib/moodle/fileType";

describe("Moodle資料のファイル種別判定", () => {
	test("Content-Typeのパラメータを除去し、既知MIMEだけを判定する", () => {
		expect(normalizeFileTypeHint("Application/PDF; charset=binary")).toBe("pdf");
		expect(
			normalizeFileTypeHint(
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			),
		).toBe("docx");
		expect(normalizeFileTypeHint("application/octet-stream")).toBeNull();
	});

	test("説明文に単語が含まれるだけではWordやPDFと誤判定しない", () => {
		expect(normalizeFileTypeHint("Wordで開くための説明ページ")).toBeNull();
		expect(normalizeFileTypeHint("PDF資料はこちらから確認できます")).toBeNull();
		expect(normalizeFileTypeHint("Word文書")).toBe("docx");
	});

	test("URLエンコード、クエリ、Content-Dispositionから拡張子を判定する", () => {
		expect(fileExtensionFromName("https://example.test/%E8%B3%87%E6%96%99.PDF?download=1")).toBe(
			"pdf",
		);
		expect(
			fileExtensionFromContentDisposition("attachment; filename*=UTF-8''lecture%20notes.pptx"),
		).toBe("pptx");
		expect(fileExtensionFromContentDisposition('attachment; filename="unknown.bin"')).toBeNull();
	});

	test("日本語DOCX名をUTF-8・Shift_JIS・旧式ヘッダーから復元する", () => {
		const rawUtf8AsLatin1 = Array.from(new TextEncoder().encode("講義資料.docx"), (byte) =>
			String.fromCharCode(byte),
		).join("");
		for (const [header, expected] of [
			["attachment; filename*=UTF-8''%E8%AC%9B%E7%BE%A9%E8%B3%87%E6%96%99.docx", "講義資料.docx"],
			["attachment; filename*=Shift_JIS''%8E%91%97%BF.docx", "資料.docx"],
			[
				'attachment; filename="=?UTF-8?Q?=E8=AC=9B=E7=BE=A9=E8=B3=87=E6=96=99.docx?="',
				"講義資料.docx",
			],
			['attachment; filename="=?UTF-8?B?6Kyb576p6LOH5paZLmRvY3g=?="', "講義資料.docx"],
			[`attachment; filename="${rawUtf8AsLatin1}"`, "講義資料.docx"],
		] as const) {
			expect(fileNameFromContentDisposition(header)).toBe(expected);
		}
	});

	test("復元不能な拡張形式は通常名へ戻し、長いDOCX名でも拡張子を保持する", () => {
		expect(
			fileNameFromContentDisposition(
				"attachment; filename*=unknown-charset''%8E%91%97%BF.docx; filename=\"資料.docx\"",
			),
		).toBe("資料.docx");
		const longName = fileNameFromContentDisposition(
			`attachment; filename="${"講".repeat(300)}.docx"`,
		);
		expect(longName?.length).toBeLessThanOrEqual(255);
		expect(longName?.endsWith(".docx")).toBe(true);
	});

	test("URLがresource/view.phpでもMIMEヒントを優先する", () => {
		expect(
			fileType({
				title: "配布資料",
				url: "https://moodle.example/mod/resource/view.php?id=1",
				moodleFileId: "1",
				sectionTitle: null,
				mimeHint: "application/zip",
			}),
		).toBe("zip");
	});
});
