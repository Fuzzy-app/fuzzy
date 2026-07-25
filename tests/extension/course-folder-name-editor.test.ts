import { describe, expect, test } from "bun:test";
import { ApiError } from "@fuzzy/shared";
import { parseHTML } from "linkedom";
import {
	buildCourseFolderNameEditor,
	courseFolderNameUpdateError,
	initialCourseFolderName,
} from "../../apps/extension/src/entrypoints/content/courseFolderNameEditor";

describe("コースフォルダ名編集UI", () => {
	const courseFolder = {
		courseId: 2,
		folderName: "英語_A",
		warnings: [
			{
				code: "name_conflict" as const,
				message: "同名になるため別名を提案しました。",
				suggestedFolderName: "英語_A",
			},
			{
				code: "name_shortened" as const,
				message: "長い名前を短縮しました。",
				suggestedFolderName: "英語_A",
			},
		],
	};

	test("警告と提案名を表示し、編集値と自動提案への復帰を通知する", () => {
		const { document, window } = parseHTML("<html><body></body></html>");
		let draft = "";
		let saved = "";
		let reset = false;
		const editor = buildCourseFolderNameEditor(
			{
				courseFolder,
				draftName: initialCourseFolderName(courseFolder),
				saving: false,
				error: null,
				onDraftChange: (value) => {
					draft = value;
				},
				onSave: (value) => {
					saved = value;
				},
				onReset: () => {
					reset = true;
				},
			},
			document,
		);
		const input = editor.querySelector<HTMLInputElement>("[data-input='course-folder-name']");
		expect(editor.textContent).toContain("同名になるため別名を提案しました。");
		expect(editor.textContent).toContain("長い名前を短縮しました。");
		expect(input?.value).toBe("英語_A");

		if (!input) throw new Error("入力欄がありません");
		input.value = "英語_会話";
		input.dispatchEvent(new window.Event("input"));
		editor.querySelector<HTMLButtonElement>("[data-action='save-course-folder-name']")?.click();
		editor.querySelector<HTMLButtonElement>("[data-action='reset-course-folder-name']")?.click();
		expect(draft).toBe("英語_会話");
		expect(saved).toBe("英語_会話");
		expect(reset).toBe(true);
	});

	test("backendの生メッセージや絶対パスを表示用エラーへ混ぜない", () => {
		const conflict = courseFolderNameUpdateError(
			new ApiError("RULE_CONFLICT", "C:\\Users\\secret\\英語 は重複しています"),
		);
		const invalid = courseFolderNameUpdateError(
			new ApiError("INVALID_REQUEST", "内部のWindows検証例外"),
		);
		expect(conflict).toBe("この名前は別のコースで使用されています。別の名前を入力してください。");
		expect(conflict).not.toContain("C:\\Users");
		expect(invalid).toBe("Windowsで使用できる80文字以内のフォルダ名を入力してください。");

		const { document } = parseHTML("<html><body></body></html>");
		const editor = buildCourseFolderNameEditor(
			{
				courseFolder,
				draftName: "英語_A",
				saving: false,
				error: conflict,
				onDraftChange: () => undefined,
				onSave: () => undefined,
				onReset: () => undefined,
			},
			document,
		);
		const input = editor.querySelector<HTMLInputElement>("[data-input='course-folder-name']");
		expect(input?.getAttribute("aria-invalid")).toBe("true");
		expect(input?.parentElement?.querySelector(".fuzzy-input-error")?.textContent).toBe(conflict);
	});
});
