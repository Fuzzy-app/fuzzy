import { ApiError, type CourseFolderNameResolution } from "@fuzzy/shared";

export interface CourseFolderNameEditorOptions {
	courseFolder: CourseFolderNameResolution;
	draftName: string;
	saving: boolean;
	error: string | null;
	onDraftChange(value: string): void;
	onSave(folderName: string): void;
	onReset(): void;
}

export function initialCourseFolderName(courseFolder: CourseFolderNameResolution): string {
	return courseFolder.warnings[0]?.suggestedFolderName ?? courseFolder.folderName;
}

/** backendの内部文言を表示せず、利用者が次に取る操作が分かる固定文言へ変換する。 */
export function courseFolderNameUpdateError(error: unknown): string {
	if (error instanceof ApiError) {
		switch (error.code) {
			case "RULE_CONFLICT":
				return "この名前は別のコースで使用されています。別の名前を入力してください。";
			case "INVALID_REQUEST":
				return "Windowsで使用できる80文字以内のフォルダ名を入力してください。";
			case "NOT_FOUND":
				return "対象のコースが見つかりません。ページを再読み込みしてください。";
		}
	}
	return "コースフォルダ名を更新できませんでした。もう一度お試しください。";
}

export function buildCourseFolderNameEditor(
	options: CourseFolderNameEditorOptions,
	doc: Document = document,
): HTMLElement {
	const editor = doc.createElement("div");
	editor.className = "fuzzy-course-folder-editor";

	if (options.courseFolder.warnings.length > 0) {
		const warnings = doc.createElement("div");
		warnings.className = "fuzzy-course-folder-warnings";
		warnings.setAttribute("role", "status");
		for (const warning of options.courseFolder.warnings) {
			const row = doc.createElement("p");
			row.dataset.warningCode = warning.code;
			row.textContent = warning.message;
			warnings.append(row);
		}
		editor.append(warnings);
	}

	const label = doc.createElement("label");
	label.className = "fuzzy-input fuzzy-course-folder-input";
	const labelText = doc.createElement("span");
	labelText.textContent = "コースフォルダ名";
	const input = doc.createElement("input");
	input.type = "text";
	input.value = options.draftName;
	input.maxLength = 80;
	input.dataset.input = "course-folder-name";
	input.disabled = options.saving || options.courseFolder.courseId === null;
	input.setAttribute("aria-invalid", String(Boolean(options.error)));
	label.append(labelText, input);

	let errorElement: HTMLElement | null = null;
	if (options.error) {
		const error = doc.createElement("small");
		error.className = "fuzzy-input-error";
		error.setAttribute("role", "alert");
		error.textContent = options.error;
		label.append(error);
		errorElement = error;
	} else if (options.courseFolder.courseId === null) {
		const help = doc.createElement("small");
		help.className = "fuzzy-course-folder-help";
		help.textContent = "このコースはまだ登録されていないため、名前を編集できません。";
		label.append(help);
	}
	editor.append(label);

	const actions = doc.createElement("div");
	actions.className = "fuzzy-course-folder-actions";
	const saveButton = doc.createElement("button");
	saveButton.type = "button";
	saveButton.dataset.action = "save-course-folder-name";
	saveButton.textContent = options.saving ? "反映中…" : "名前を反映";
	const resetButton = doc.createElement("button");
	resetButton.type = "button";
	resetButton.dataset.action = "reset-course-folder-name";
	resetButton.textContent = "自動提案へ戻す";

	const updateDisabledState = () => {
		const unavailable = options.saving || options.courseFolder.courseId === null;
		saveButton.disabled = unavailable || input.value.trim().length === 0;
		resetButton.disabled = unavailable;
	};
	input.addEventListener("input", () => {
		options.onDraftChange(input.value);
		input.setAttribute("aria-invalid", "false");
		errorElement?.remove();
		errorElement = null;
		updateDisabledState();
	});
	saveButton.addEventListener("click", () => options.onSave(input.value.trim()));
	resetButton.addEventListener("click", options.onReset);
	updateDisabledState();
	actions.append(saveButton, resetButton);
	editor.append(actions);

	return editor;
}
