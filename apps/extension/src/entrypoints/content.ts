import { type FuzzyApiClient, type SaveSuggestion, createApiClient } from "@fuzzy/shared";
import {
	MOODLE_PAGE_SNAPSHOT_MESSAGE,
	type MoodleFileLink,
	type MoodlePageSnapshot,
	collectMoodlePageSnapshot,
	extractFileLinks,
	extractFolderLinks,
} from "../lib/moodle/pageSnapshot";

const PANEL_ID = "fuzzy-save-panel";

// Moodleページで動くコンテンツスクリプト。
// DOM解析（ファイルリンク・本文・ダッシュボード取得、issue #48）を行う。
// TODO: matches を大学のMoodleの実URLに合わせる（担当: matoba）。
export default defineContentScript({
	matches: ["*://*.wakayama-u.ac.jp/*"],
	main() {
		const runtime = getChromeRuntime();

		if (runtime?.onMessage?.addListener) {
			runtime.onMessage.addListener((message, _sender, sendResponse) => {
				if (message?.type !== MOODLE_PAGE_SNAPSHOT_MESSAGE) return false;

				void collectMoodlePageSnapshotWithNestedFolders().then((snapshot) => {
					sendResponse({ snapshot });
				});
				return true;
			});
		}

		const snapshot = safeCollectMoodlePageSnapshot();
		console.info("[fuzzy] Moodleページ情報を取得しました", {
			courseName: snapshot.courseName,
			sectionTitle: snapshot.sectionTitle,
			fileCount: snapshot.files.length,
			assignmentHintCount: snapshot.assignmentHints.length,
		});

		void mountSavePanel();
	},
});

function getChromeRuntime():
	| { onMessage?: { addListener?: (listener: MessageListener) => void } }
	| undefined {
	// biome-ignore lint/suspicious/noExplicitAny: content scriptではブラウザが注入するchromeを参照するため
	return (globalThis as any).chrome?.runtime;
}

function safeCollectMoodlePageSnapshot() {
	try {
		return collectMoodlePageSnapshot(document);
	} catch (error) {
		console.error("[fuzzy] Moodleページ情報の取得に失敗しました", error);
		return {
			courseName: null,
			sectionTitle: null,
			breadcrumbs: [],
			files: [],
			pageText: "",
			dashboardText: "",
			assignmentHints: [],
			collectedAt: new Date().toISOString(),
		};
	}
}

async function collectMoodlePageSnapshotWithNestedFolders(): Promise<MoodlePageSnapshot> {
	const snapshot = safeCollectMoodlePageSnapshot();
	const nestedFiles = await collectNestedFolderFiles(document);

	return {
		...snapshot,
		files: dedupeFiles([...snapshot.files, ...nestedFiles]),
		collectedAt: new Date().toISOString(),
	};
}

async function collectNestedFolderFiles(
	root: Document | Element,
	depth = 0,
	seenFolders = new Set<string>(),
): Promise<MoodleFileLink[]> {
	if (depth >= 2) return [];

	const folders = extractFolderLinks(root).filter((folder) => {
		if (!isSameOriginUrl(folder.url) || seenFolders.has(folder.url)) return false;
		seenFolders.add(folder.url);
		return true;
	});

	const filesByFolder = await Promise.all(
		folders.map(async (folder) => {
			try {
				const folderDocument = await fetchMoodleDocument(folder.url);
				const directFiles = extractFileLinks(folderDocument).map((file) => ({
					...file,
					sectionTitle: file.sectionTitle ?? folder.sectionTitle ?? folder.title,
				}));
				const nestedFiles = await collectNestedFolderFiles(folderDocument, depth + 1, seenFolders);

				return [
					...directFiles,
					...nestedFiles.map((file) => ({
						...file,
						sectionTitle: file.sectionTitle ?? folder.sectionTitle ?? folder.title,
					})),
				];
			} catch (error) {
				console.warn("[fuzzy] Moodleフォルダ内の資料取得に失敗しました", {
					url: folder.url,
					error,
				});
				return [];
			}
		}),
	);

	return dedupeFiles(filesByFolder.flat());
}

async function fetchMoodleDocument(url: string): Promise<Document> {
	const response = await fetch(url, { credentials: "include" });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);

	const html = await response.text();
	const parsed = new DOMParser().parseFromString(html, "text/html");
	const base = parsed.createElement("base");
	base.href = url;
	parsed.head.prepend(base);
	return parsed;
}

function isSameOriginUrl(url: string): boolean {
	try {
		return new URL(url).origin === location.origin;
	} catch {
		return false;
	}
}

function dedupeFiles(files: MoodleFileLink[]): MoodleFileLink[] {
	const seen = new Set<string>();
	return files.filter((file) => {
		if (seen.has(file.url)) return false;
		seen.add(file.url);
		return true;
	});
}

async function mountSavePanel() {
	const existing = document.getElementById(PANEL_ID);
	existing?.remove();

	const panel = document.createElement("aside");
	panel.id = PANEL_ID;
	panel.setAttribute("aria-label", "Fuzzy 資料一括保存");
	document.body.append(panel);

	let api: FuzzyApiClient | null = null;
	let snapshot = safeCollectMoodlePageSnapshot();
	let suggestions: SaveSuggestion[] = [];
	let selectedFileIds = new Set(snapshot.files.map(fileId));
	let selectedPath = "";
	let manualPath = "";
	let zipMode: "extract" | "keep" = "extract";
	let flattenZip = true;
	let extractDestinationPath = "";
	let loading = true;
	let saving = false;
	let isPanelOpen = true;
	let message: string | null = "Moodleページ内の資料を読み込んでいます。";

	injectPanelStyle();
	render();

	try {
		const [client, fullSnapshot] = await Promise.all([
			createApiClient(),
			collectMoodlePageSnapshotWithNestedFolders(),
		]);
		api = client;
		snapshot = fullSnapshot;
		selectedFileIds = new Set(snapshot.files.map(fileId));
		suggestions = await loadSuggestions(api, snapshot);
		selectedPath = suggestions[0]?.path ?? "";
		message = null;
	} catch (error) {
		message =
			error instanceof Error
				? `保存先候補の取得に失敗しました: ${error.message}`
				: "保存先候補の取得に失敗しました。";
	} finally {
		loading = false;
		render();
	}

	function refreshSnapshot() {
		void reloadSnapshotAndSuggestions();
	}

	async function reloadSnapshotAndSuggestions() {
		loading = true;
		message = "Moodleページ内の資料を再読み込みしています。";
		render();

		try {
			snapshot = await collectMoodlePageSnapshotWithNestedFolders();
			selectedFileIds = new Set(snapshot.files.map(fileId));
			suggestions = api ? await loadSuggestions(api, snapshot) : [];
			selectedPath = suggestions[0]?.path ?? "";
			message = null;
		} catch (error) {
			message =
				error instanceof Error
					? `Moodleページ内の資料取得に失敗しました: ${error.message}`
					: "Moodleページ内の資料取得に失敗しました。";
		} finally {
			loading = false;
			render();
		}
	}

	async function saveSelectedFiles() {
		if (!api || saving) return;

		const selectedFiles = snapshot.files.filter((file) => selectedFileIds.has(fileId(file)));
		const targetPath = manualPath.trim() || selectedPath;
		if (selectedFiles.length === 0 || targetPath.length === 0) return;

		saving = true;
		message = "保存処理を実行しています。";
		render();

		try {
			const result = await api.saveFiles({ files: selectedFiles, targetPath });
			const zipFiles = selectedFiles.filter(isZipFile);
			const destinationPath = extractDestinationPath.trim() || targetPath;
			const extracted =
				zipMode === "extract"
					? await Promise.all(
							zipFiles.map((file) =>
								api?.extractZip({
									fileMeta: file,
									targetPath,
									destinationPath,
									flatten: flattenZip,
								}),
							),
						)
					: [];

			const extractedCount = extracted.flatMap((item) => item?.extractedPaths ?? []).length;
			message =
				extractedCount > 0
					? `${result.savedFileIds.length}件を保存し、ZIPから${extractedCount}件を展開しました。`
					: `${result.savedFileIds.length}件の資料を保存しました。`;
		} catch (error) {
			message =
				error instanceof Error ? `保存に失敗しました: ${error.message}` : "保存に失敗しました。";
		} finally {
			saving = false;
			render();
		}
	}

	function render() {
		panel.classList.toggle("is-collapsed", !isPanelOpen);
		const selectedFiles = snapshot.files.filter((file) => selectedFileIds.has(fileId(file)));
		const zipFiles = selectedFiles.filter(isZipFile);
		const targetPath = manualPath.trim() || selectedPath;
		const destinationPath = extractDestinationPath.trim() || targetPath;
		const canSave = selectedFiles.length > 0 && targetPath.length > 0 && !saving;

		panel.innerHTML = "";

		if (!isPanelOpen) {
			const openButton = document.createElement("button");
			openButton.className = "fuzzy-panel-tab";
			openButton.type = "button";
			openButton.textContent = "Fuzzy";
			openButton.setAttribute("aria-label", "Fuzzyの一括保存パネルを開く");
			openButton.addEventListener("click", () => {
				isPanelOpen = true;
				render();
			});
			panel.append(openButton);
			return;
		}

		const handle = document.createElement("button");
		handle.className = "fuzzy-panel-handle";
		handle.type = "button";
		handle.textContent = "›";
		handle.setAttribute("aria-label", "Fuzzyの一括保存パネルを閉じる");
		handle.addEventListener("click", () => {
			isPanelOpen = false;
			render();
		});
		panel.append(handle);

		const header = document.createElement("div");
		header.className = "fuzzy-panel-header";
		header.innerHTML = `
			<div>
				<p><span class="fuzzy-logo">F</span><strong>Fuzzy</strong><span class="fuzzy-pill">ブラウザ拡張</span></p>
				<small>ダウンロードを検出・コース「${escapeHtml(snapshot.courseName ?? "未取得")}」</small>
			</div>
			<div class="fuzzy-panel-tools">
				<button type="button" data-action="refresh" aria-label="Fuzzyの資料一覧を更新">↻</button>
				<button type="button" data-action="collapse" aria-label="Fuzzyの一括保存パネルを閉じる">×</button>
			</div>
		`;
		panel.append(header);

		if (message) {
			const note = document.createElement("p");
			note.className = loading || saving ? "fuzzy-note" : "fuzzy-note fuzzy-note-result";
			note.textContent = message;
			panel.append(note);
		}

		panel.append(renderFileList(snapshot.files));
		panel.append(renderPathSection());

		if (zipFiles.length > 0) {
			panel.append(renderZipSection(zipFiles.length, destinationPath));
		}

		const actions = document.createElement("div");
		actions.className = "fuzzy-actions";
		const summaryText =
			selectedFiles.length === 0
				? "保存する資料を選択してください。"
				: targetPath.length === 0
					? "保存先を選択してください。"
					: zipFiles.length > 0 && zipMode === "extract"
						? `${selectedFiles.length}件を保存し、ZIP ${zipFiles.length}件を ${destinationPath} に展開します。`
						: `${selectedFiles.length}件を ${targetPath} に保存します。`;
		actions.innerHTML = `
			<p>${escapeHtml(summaryText)}</p>
			<div class="fuzzy-action-meta">
				<button type="button" data-action="toggle-all-footer">すべて選択 / 解除</button>
				<span>選択中: ${selectedFiles.length}件</span>
			</div>
			<button type="button" data-action="save" ${canSave ? "" : "disabled"}>
				${saving ? "保存中" : "選んだ場所にダウンロード"}
			</button>
		`;
		panel.append(actions);

		panel
			.querySelector<HTMLButtonElement>("[data-action='refresh']")
			?.addEventListener("click", refreshSnapshot);
		panel
			.querySelector<HTMLButtonElement>("[data-action='collapse']")
			?.addEventListener("click", () => {
				isPanelOpen = false;
				render();
			});
		panel
			.querySelector<HTMLButtonElement>("[data-action='save']")
			?.addEventListener("click", () => {
				void saveSelectedFiles();
			});
		panel
			.querySelector<HTMLButtonElement>("[data-action='toggle-all-footer']")
			?.addEventListener("click", () => {
				if (selectedFileIds.size === snapshot.files.length) selectedFileIds.clear();
				else selectedFileIds = new Set(snapshot.files.map(fileId));
				message = null;
				render();
			});
	}

	function renderFileList(files: MoodleFileLink[]) {
		const section = document.createElement("section");
		section.className = "fuzzy-section";

		const list = files
			.map(
				(file) => `
					<label class="fuzzy-file-row">
						<input type="checkbox" data-file-id="${escapeHtml(fileId(file))}" ${
							selectedFileIds.has(fileId(file)) ? "checked" : ""
						} />
						<span class="fuzzy-file-type" data-kind="${escapeHtml(fileType(file).toLowerCase())}">${escapeHtml(fileType(file).toUpperCase())}</span>
						<strong>${escapeHtml(file.title)}</strong>
						<small>${escapeHtml(file.sectionTitle ?? snapshot.sectionTitle ?? "セクション未取得")}</small>
					</label>
				`,
			)
			.join("");

		section.innerHTML = `
			<div class="fuzzy-section-heading">
				<h3>保存できるファイル（このページ）</h3>
				<button type="button" data-action="toggle-all">全選択</button>
			</div>
			<div class="fuzzy-file-list">${
				files.length > 0
					? list
					: "<p class='fuzzy-empty'>このページでは資料リンクが見つかりませんでした。</p>"
			}</div>
		`;

		for (const input of section.querySelectorAll<HTMLInputElement>(
			"input[type='checkbox'][data-file-id]",
		)) {
			input.addEventListener("change", () => {
				const id = input.dataset.fileId;
				if (!id) return;
				if (input.checked) selectedFileIds.add(id);
				else selectedFileIds.delete(id);
				message = null;
				render();
			});
		}

		section
			.querySelector<HTMLButtonElement>("[data-action='toggle-all']")
			?.addEventListener("click", () => {
				if (selectedFileIds.size === files.length) selectedFileIds.clear();
				else selectedFileIds = new Set(files.map(fileId));
				message = null;
				render();
			});

		return section;
	}

	function renderPathSection() {
		const section = document.createElement("section");
		section.className = "fuzzy-section";

		const suggestionOptions = suggestions
			.slice(1)
			.map(
				(suggestion) => `
					<label class="fuzzy-path-option">
						<input type="radio" name="fuzzy-save-path" value="${escapeHtml(suggestion.path)}" ${
							selectedPath === suggestion.path && manualPath.trim() === "" ? "checked" : ""
						} />
						<span>
							<strong>${escapeHtml(suggestion.path)}</strong>
							<small>${Math.round(suggestion.confidence * 100)}%</small>
						</span>
					</label>
				`,
			)
			.join("");
		const primarySuggestion = suggestions[0];
		const shortPathLabel = primarySuggestion
			? toShortPathLabel(primarySuggestion.path)
			: "…/保存先/";

		section.innerHTML = `
			<div class="fuzzy-section-heading"><h3>保存先（提案）</h3></div>
			${
				primarySuggestion
					? `<label class="fuzzy-path-feature">
						<input type="radio" name="fuzzy-save-path" value="${escapeHtml(primarySuggestion.path)}" ${
							selectedPath === primarySuggestion.path && manualPath.trim() === "" ? "checked" : ""
						} />
						<span>
							<strong>${escapeHtml(primarySuggestion.path)}</strong>
							<small>ルールに一致</small>
						</span>
						<em>おすすめ</em>
					</label>`
					: ""
			}
			<div class="fuzzy-path-chips">
				<button type="button" data-action="use-short-path">${escapeHtml(shortPathLabel)}</button>
				<button type="button" data-action="use-same-path">前回と同じ場所</button>
			</div>
			<a class="fuzzy-path-link" href="#" data-action="show-paths">別の候補から選ぶ</a>
			<div class="fuzzy-path-list">${
				suggestions.length > 1
					? suggestionOptions
					: "<p class='fuzzy-empty'>保存先候補はまだありません。</p>"
			}</div>
			<label class="fuzzy-input">
				<span>手動で指定</span>
				<input type="text" data-input="manual-path" value="${escapeHtml(manualPath)}" placeholder="C:\\Users\\sample\\Documents\\大学\\2026前期" />
			</label>
		`;

		for (const input of section.querySelectorAll<HTMLInputElement>(
			"input[name='fuzzy-save-path']",
		)) {
			input.addEventListener("change", () => {
				selectedPath = input.value;
				manualPath = "";
				message = null;
				render();
			});
		}

		section
			.querySelector<HTMLButtonElement>("[data-action='use-short-path']")
			?.addEventListener("click", () => {
				manualPath = selectedPath;
				message = null;
				render();
			});

		section
			.querySelector<HTMLButtonElement>("[data-action='use-same-path']")
			?.addEventListener("click", () => {
				manualPath = selectedPath;
				message = null;
				render();
			});

		section
			.querySelector<HTMLAnchorElement>("[data-action='show-paths']")
			?.addEventListener("click", (event) => {
				event.preventDefault();
				message = "保存先候補を下に表示しています。必要なら手動指定もできます。";
				render();
			});

		section
			.querySelector<HTMLInputElement>("[data-input='manual-path']")
			?.addEventListener("input", (event) => {
				manualPath = inputValue(event);
				message = null;
			});

		return section;
	}

	function renderZipSection(zipCount: number, destinationPath: string) {
		const section = document.createElement("section");
		section.className = "fuzzy-section";
		section.innerHTML = `
			<div class="fuzzy-section-heading"><h3>ZIPファイル</h3><span>${zipCount}件</span></div>
			<label class="fuzzy-path-option">
				<input type="radio" name="fuzzy-zip-mode" value="extract" ${zipMode === "extract" ? "checked" : ""} />
				<span><strong>保存後に展開する</strong><small>授業資料としてすぐ使える形にします。</small></span>
			</label>
			<label class="fuzzy-path-option">
				<input type="radio" name="fuzzy-zip-mode" value="keep" ${zipMode === "keep" ? "checked" : ""} />
				<span><strong>ZIPのまま保存する</strong><small>圧縮ファイルをそのまま残します。</small></span>
			</label>
			<label class="fuzzy-check">
				<input type="checkbox" data-input="flatten-zip" ${flattenZip ? "checked" : ""} ${zipMode === "keep" ? "disabled" : ""} />
				<span>無駄な二重フォルダがあれば簡略化する</span>
			</label>
			<label class="fuzzy-input">
				<span>展開先フォルダ</span>
				<input type="text" data-input="extract-path" value="${escapeHtml(extractDestinationPath)}" ${
					zipMode === "keep" ? "disabled" : ""
				} placeholder="${escapeHtml(destinationPath || "保存先と同じフォルダ")}" />
			</label>
		`;

		for (const input of section.querySelectorAll<HTMLInputElement>(
			"input[name='fuzzy-zip-mode']",
		)) {
			input.addEventListener("change", () => {
				zipMode = input.value === "keep" ? "keep" : "extract";
				message = null;
				render();
			});
		}

		section
			.querySelector<HTMLInputElement>("[data-input='flatten-zip']")
			?.addEventListener("change", (event) => {
				flattenZip = inputChecked(event);
				message = null;
				render();
			});

		section
			.querySelector<HTMLInputElement>("[data-input='extract-path']")
			?.addEventListener("input", (event) => {
				extractDestinationPath = inputValue(event);
				message = null;
			});

		return section;
	}
}

async function loadSuggestions(api: FuzzyApiClient, snapshot: MoodlePageSnapshot) {
	return api.suggestSavePath({
		course: {
			name: snapshot.courseName,
			sectionTitle: snapshot.sectionTitle,
			breadcrumbs: snapshot.breadcrumbs,
		},
		fileMeta: snapshot.files[0] ?? null,
	});
}

function fileId(file: MoodleFileLink): string {
	return file.url;
}

function fileType(file: MoodleFileLink): string {
	return file.mimeHint ?? file.title.split(".").pop()?.toLowerCase() ?? "file";
}

function isZipFile(file: MoodleFileLink): boolean {
	return fileType(file) === "zip" || /\.zip(?:$|[?#])/i.test(file.url);
}

function toShortPathLabel(path: string): string {
	const parts = path.split(/[\\/]+/).filter(Boolean);
	return parts.length > 0 ? `…/${parts.slice(-2).join("/")}/` : "…/保存先/";
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function inputValue(event: Event): string {
	return event.currentTarget instanceof HTMLInputElement ? event.currentTarget.value : "";
}

function inputChecked(event: Event): boolean {
	return event.currentTarget instanceof HTMLInputElement ? event.currentTarget.checked : false;
}

function injectPanelStyle() {
	if (document.getElementById("fuzzy-save-panel-style")) return;

	const style = document.createElement("style");
	style.id = "fuzzy-save-panel-style";
	style.textContent = `
		#${PANEL_ID} {
			position: fixed;
			top: 0;
			right: 0;
			z-index: 2147483647;
			width: min(300px, calc(100vw - 24px));
			height: 100vh;
			box-sizing: border-box;
			overflow: auto;
			border-left: 1px solid #e2e6f0;
			border-top: 3px solid #635bff;
			border-radius: 0;
			background: #ffffff;
			box-shadow: -18px 0 36px rgb(22 34 51 / 10%);
			color: #202537;
			font-family: "Yu Gothic UI", Meiryo, system-ui, sans-serif;
		}

		#${PANEL_ID}.is-collapsed {
			top: 50%;
			right: 0;
			height: auto;
			width: auto;
			max-height: none;
			overflow: visible;
			border: 0;
			border-radius: 0;
			background: transparent;
			box-shadow: none;
			transform: translateY(-50%);
		}

		#${PANEL_ID} * {
			box-sizing: border-box;
		}

		#${PANEL_ID} button,
		#${PANEL_ID} input {
			font: inherit;
		}

		.fuzzy-panel-header,
		.fuzzy-section,
		.fuzzy-actions {
			border-top: 1px solid #eef1f6;
			padding: 9px 12px;
		}

		.fuzzy-panel-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			border-top: 0;
			background: #ffffff;
		}

		.fuzzy-panel-tools {
			display: flex;
			flex: 0 0 auto;
			gap: 5px;
		}

		.fuzzy-panel-header p,
		.fuzzy-panel-header h2,
		.fuzzy-section h3,
		.fuzzy-actions p,
		.fuzzy-note {
			margin: 0;
		}

		.fuzzy-panel-header p {
			display: flex;
			align-items: center;
			gap: 6px;
			color: #202537;
			font-size: 13px;
			font-weight: 800;
		}

		.fuzzy-panel-header small {
			display: block;
			margin-top: 3px;
			color: #8b93a7;
			font-size: 10px;
			font-weight: 700;
			line-height: 1.35;
		}

		.fuzzy-logo {
			display: inline-grid;
			place-items: center;
			width: 22px;
			height: 22px;
			border-radius: 6px;
			background: #635bff;
			color: #ffffff;
			font-size: 13px;
			font-weight: 900;
		}

		.fuzzy-pill {
			border-radius: 999px;
			background: #f0efff;
			padding: 2px 7px;
			color: #635bff;
			font-size: 10px;
			font-weight: 900;
		}

		.fuzzy-panel-handle {
			position: absolute;
			top: 50%;
			left: -18px;
			width: 20px;
			height: 52px;
			border-radius: 8px 0 0 8px !important;
			padding: 0 !important;
			transform: translateY(-50%);
			box-shadow: -6px 0 18px rgb(22 34 51 / 14%);
			font-size: 18px !important;
			line-height: 1;
		}

		.fuzzy-panel-tab {
			writing-mode: vertical-rl;
			min-width: 36px;
			min-height: 84px;
			border-radius: 8px 0 0 8px !important;
			box-shadow: 0 12px 32px rgb(22 34 51 / 22%);
			letter-spacing: 0;
			font-size: 13px !important;
		}

		#${PANEL_ID} button {
			border: 0;
			border-radius: 8px;
			background: #5d5ce2;
			padding: 7px 9px;
			color: #ffffff;
			font-weight: 800;
			cursor: pointer;
			line-height: 1.2;
		}

		.fuzzy-panel-tools button {
			display: inline-grid;
			place-items: center;
			width: 30px;
			height: 30px;
			padding: 0 !important;
			border-radius: 9px !important;
			writing-mode: horizontal-tb;
			font-size: 16px;
		}

		#${PANEL_ID} button:disabled {
			background: #a9afc7;
			cursor: not-allowed;
		}

		.fuzzy-panel-summary {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 8px;
			padding: 12px;
			background: #ffffff;
		}

		.fuzzy-panel-summary div {
			display: grid;
			gap: 3px;
			min-width: 0;
		}

		.fuzzy-panel-summary span,
		.fuzzy-file-row small,
		.fuzzy-path-option small,
		.fuzzy-input span,
		.fuzzy-empty {
			color: #687083;
			font-size: 11px;
			font-weight: 700;
		}

		.fuzzy-panel-summary strong,
		.fuzzy-file-row strong,
		.fuzzy-path-option strong {
			overflow-wrap: anywhere;
			font-size: 12px;
		}

		.fuzzy-note {
			margin: 0 10px 9px;
			border-radius: 8px;
			background: #edf1ff;
			padding: 7px 8px;
			color: #34398e;
			font-size: 11px;
			font-weight: 800;
			line-height: 1.5;
		}

		.fuzzy-note-result {
			background: #e2f8ef;
			color: #087457;
		}

		.fuzzy-section-heading {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 8px;
			margin-bottom: 7px;
		}

		.fuzzy-section-heading h3 {
			font-size: 11px;
			font-weight: 900;
		}

		.fuzzy-section-heading button {
			background: transparent;
			color: #5d5ce2;
			font-size: 10px;
		}

		.fuzzy-file-list,
		.fuzzy-path-list {
			display: grid;
			gap: 7px;
		}

		.fuzzy-file-row,
		.fuzzy-path-option,
		.fuzzy-path-feature,
		.fuzzy-check,
		.fuzzy-input {
			display: grid;
			gap: 5px;
			border: 1px solid #e2e6f0;
			border-radius: 8px;
			padding: 7px;
		}

		.fuzzy-file-row,
		.fuzzy-path-option,
		.fuzzy-path-feature,
		.fuzzy-check {
			grid-template-columns: auto minmax(0, 1fr);
			align-items: start;
		}

		.fuzzy-file-row:has(input:checked),
		.fuzzy-path-option:has(input:checked),
		.fuzzy-path-feature:has(input:checked) {
			border-color: #746dff;
			background: #f1f0ff;
			box-shadow: inset 0 0 0 1px #746dff;
		}

		.fuzzy-file-row input,
		.fuzzy-path-option input,
		.fuzzy-path-feature input,
		.fuzzy-check input {
			accent-color: #635bff;
		}

		.fuzzy-file-type {
			grid-column: 2;
			width: fit-content;
			border-radius: 4px;
			background: #ef4444;
			padding: 2px 7px;
			color: #ffffff;
			font-size: 10px;
			font-weight: 900;
		}

		.fuzzy-file-type[data-kind="ppt"],
		.fuzzy-file-type[data-kind="pptx"] {
			background: #f59e0b;
		}

		.fuzzy-file-type[data-kind="doc"],
		.fuzzy-file-type[data-kind="docx"] {
			background: #3b82f6;
		}

		.fuzzy-file-type[data-kind="zip"] {
			background: #64748b;
		}

		.fuzzy-file-row input {
			grid-row: 1 / span 3;
		}

		.fuzzy-file-row small {
			grid-column: 2;
		}

		.fuzzy-path-option span {
			display: grid;
			gap: 3px;
			min-width: 0;
		}

		.fuzzy-path-feature {
			grid-template-columns: auto minmax(0, 1fr) auto;
			margin-bottom: 8px;
		}

		.fuzzy-path-feature span {
			display: grid;
			gap: 3px;
			min-width: 0;
		}

		.fuzzy-path-feature em {
			align-self: center;
			border-radius: 999px;
			background: #c9f7dd;
			padding: 4px 8px;
			color: #0f9f6e;
			font-size: 10px;
			font-style: normal;
			font-weight: 900;
		}

		.fuzzy-path-chips {
			display: grid;
			grid-template-columns: 1fr 1fr;
			gap: 8px;
			margin-bottom: 7px;
		}

		.fuzzy-path-chips button {
			overflow: hidden;
			background: #eef1f6 !important;
			color: #657086 !important;
			text-overflow: ellipsis;
			white-space: nowrap;
			font-size: 11px;
		}

		.fuzzy-path-link {
			display: inline-block;
			margin-bottom: 8px;
			color: #5d5ce2;
			font-size: 11px;
			font-weight: 900;
			text-decoration: none;
		}

		.fuzzy-input input {
			width: 100%;
			min-height: 34px;
			border: 1px solid #dfe4f0;
			border-radius: 8px;
			padding: 0 8px;
			font-size: 12px;
		}

		.fuzzy-actions {
			position: sticky;
			bottom: 0;
			display: grid;
			gap: 7px;
			background: #ffffff;
			box-shadow: 0 -8px 22px rgb(22 34 51 / 8%);
		}

		.fuzzy-actions p {
			border-radius: 8px;
			background: transparent;
			padding: 0;
			color: #657086;
			font-size: 11px;
			font-weight: 800;
			line-height: 1.5;
		}

		.fuzzy-action-meta {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 8px;
			color: #657086;
			font-size: 10px;
			font-weight: 900;
		}

		.fuzzy-action-meta button {
			background: transparent !important;
			padding: 0 !important;
			color: #5d5ce2 !important;
			font-size: 11px;
		}

		.fuzzy-actions > button {
			min-height: 40px;
			box-shadow: 0 8px 18px rgb(93 92 226 / 28%);
		}
	`;
	document.head.append(style);
}

type MessageListener = (
	message: { type?: string },
	sender: unknown,
	sendResponse: (response: unknown) => void,
) => boolean;
