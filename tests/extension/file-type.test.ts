import { describe, expect, test } from "bun:test";
import {
	fileExtensionFromContentDisposition,
	fileExtensionFromName,
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
