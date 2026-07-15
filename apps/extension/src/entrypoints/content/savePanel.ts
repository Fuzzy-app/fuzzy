// Fuzzy保存パネル（issue48〜51: 資料検出・保存先サジェスト・一括保存・ZIP展開提案・類似ファイル通知）。
// mainのcontent/モジュール分割方針に合わせ、このモジュールはDOM構築のみを担当する。
// スナップショット収集は ../../lib/moodle/snapshotCollector、
// native-host接続は background 経由（../../lib/api/backgroundApi）に委譲する。
import type { SaveSuggestion, SimilarFileMatch } from "@fuzzy/shared";
import { BackgroundApiClient } from "../../lib/api/backgroundApi";
import type { MoodleFileLink, MoodlePageSnapshot } from "../../lib/moodle/pageSnapshot";
import {
	collectMoodlePageSnapshotWithNestedFolders,
	safeCollectMoodlePageSnapshot,
} from "../../lib/moodle/snapshotCollector";
import {
	SAVE_HANDLE_ID,
	SAVE_PANEL_ID,
	SAVE_PANEL_STYLE,
	SAVE_PANEL_STYLE_ID,
} from "./savePanelStyle";

/** 直近の保存先を記憶しておくstorageキー（「前回と同じ場所」で再利用する）。 */
const LAST_SAVE_PATH_KEY = "fuzzy:lastSavePath";
/** ページ遷移後も右側の保存パネルの開閉状態を復元する。 */
const SAVE_PANEL_OPEN_STATE_KEY = "fuzzy:savePanelOpen";

interface SimilarWarning {
	file: MoodleFileLink;
	match: SimilarFileMatch;
}

export async function mountSavePanel(): Promise<void> {
	document.getElementById(SAVE_PANEL_ID)?.remove();
	document.getElementById(SAVE_HANDLE_ID)?.remove();
	// 状態を復元してからDOMを挿入することで、閉じた表示から開いた表示への
	// 描画し直しを避ける。
	const initialPanelOpen = await loadPanelOpenState();

	const panel = document.createElement("aside");
	panel.id = SAVE_PANEL_ID;
	panel.setAttribute("aria-label", "Fuzzy 資料一括保存");
	document.body.append(panel);

	// 開閉ハンドル（›）はパネル本体のoverflowにクリップされないよう、
	// パネルとは別に body 直下へ固定配置する（パネル左端のすぐ外側に表示）。
	const collapseHandle = document.createElement("button");
	collapseHandle.id = SAVE_HANDLE_ID;
	collapseHandle.type = "button";
	const collapseArrow = document.createElement("span");
	collapseArrow.className = "fuzzy-collapse-arrow";
	collapseArrow.textContent = "›";
	collapseHandle.append(collapseArrow);
	collapseHandle.setAttribute("aria-label", "Fuzzyの一括保存パネルを閉じる");
	collapseHandle.addEventListener("click", () => setPanelOpen(false));
	document.body.append(collapseHandle);

	const api = new BackgroundApiClient();
	let snapshot = safeCollectMoodlePageSnapshot();
	let suggestions: SaveSuggestion[] = [];
	let selectedFileIds = new Set(snapshot.files.map(fileId));
	let selectedPath = "";
	let manualPath = "";
	let lastSavePath = "";
	let zipMode: "extract" | "keep" = "extract";
	let flattenZip = true;
	let extractDestinationPath = "";
	// 類似ファイル通知（issue51）: 保存前チェックの状態。
	let similarWarnings: SimilarWarning[] = [];
	let checkingSimilar = false;
	let awaitingConfirm = false;
	let loading = true;
	let saving = false;
	let isPanelOpen = initialPanelOpen;
	let message: string | null = "Moodleページ内の資料を読み込んでいます。";

	injectPanelStyle();
	render();
	void initialize();

	async function initialize() {
		try {
			const [fullSnapshot, storedPath] = await Promise.all([
				collectMoodlePageSnapshotWithNestedFolders(),
				loadLastSavePath(),
			]);
			snapshot = fullSnapshot;
			lastSavePath = storedPath;
			selectedFileIds = new Set(snapshot.files.map(fileId));
			suggestions = rankSuggestions(await loadSuggestions(api, snapshot));
			selectedPath = suggestions[0]?.path ?? "";
			message = null;
		} catch (error) {
			message = toErrorMessage(error, "保存先候補の取得に失敗しました");
		} finally {
			loading = false;
			render();
		}
	}

	async function reloadSnapshotAndSuggestions() {
		loading = true;
		resetConfirmState();
		message = "Moodleページ内の資料を再読み込みしています。";
		render();
		try {
			snapshot = await collectMoodlePageSnapshotWithNestedFolders();
			selectedFileIds = new Set(snapshot.files.map(fileId));
			suggestions = rankSuggestions(await loadSuggestions(api, snapshot));
			selectedPath = suggestions[0]?.path ?? "";
			message = null;
		} catch (error) {
			message = toErrorMessage(error, "Moodleページ内の資料取得に失敗しました");
		} finally {
			loading = false;
			render();
		}
	}

	/**
	 * 保存を実行する。issue51の完了条件に従い、保存前に必ず類似ファイルを照合し、
	 * 該当があれば続行/キャンセルの確認を挟む。confirmed=true は「このまま保存」押下後の再入。
	 */
	async function saveSelectedFiles(confirmed = false) {
		if (saving) return;

		const selectedFiles = snapshot.files.filter((file) => selectedFileIds.has(fileId(file)));
		const targetPath = currentTargetPath();
		if (selectedFiles.length === 0 || targetPath.length === 0) return;

		if (!confirmed && !(await ensureSimilarChecked(selectedFiles))) {
			return; // 類似あり→確認待ちで一旦中断
		}

		saving = true;
		awaitingConfirm = false;
		message = "保存処理を実行しています。";
		render();
		try {
			const result = await api.saveFiles({ files: selectedFiles, targetPath });
			const extractedCount = await extractSelectedZips(selectedFiles, targetPath);
			await saveLastSavePath(targetPath);
			lastSavePath = targetPath;
			similarWarnings = [];
			message =
				extractedCount > 0
					? `${result.savedFileIds.length}件を保存し、ZIPから${extractedCount}件を展開しました。`
					: `${result.savedFileIds.length}件の資料を保存しました。`;
		} catch (error) {
			message = toErrorMessage(error, "保存に失敗しました");
		} finally {
			saving = false;
			render();
		}
	}

	/**
	 * 選択ファイルの類似チェックを実行する。
	 * 該当が無ければ true（そのまま保存へ）、該当があれば確認UIを表示して false を返す。
	 */
	async function ensureSimilarChecked(files: MoodleFileLink[]): Promise<boolean> {
		checkingSimilar = true;
		message = "保存済み資料と照合しています。";
		render();
		try {
			similarWarnings = await collectSimilarWarnings(files);
		} catch (error) {
			// 照合に失敗しても保存自体は止めない（フェイルオープン）。
			console.warn("[fuzzy] 類似ファイルの照合に失敗しました", error);
			similarWarnings = [];
		} finally {
			checkingSimilar = false;
		}

		if (similarWarnings.length === 0) {
			message = null;
			return true;
		}
		awaitingConfirm = true;
		message = null;
		render();
		return false;
	}

	async function collectSimilarWarnings(files: MoodleFileLink[]): Promise<SimilarWarning[]> {
		const byFile = await Promise.all(
			files.map(async (file) => {
				const matches = await api.checkSimilarFiles({ fileMeta: file });
				return matches.map((match) => ({ file, match }));
			}),
		);
		return byFile.flat();
	}

	async function extractSelectedZips(files: MoodleFileLink[], targetPath: string): Promise<number> {
		if (zipMode !== "extract") return 0;
		const zipFiles = files.filter(isZipFile);
		if (zipFiles.length === 0) return 0;

		const destinationPath = extractDestinationPath.trim() || targetPath;
		const extracted = await Promise.all(
			zipFiles.map((file) =>
				api.extractZip({ fileMeta: file, targetPath, destinationPath, flatten: flattenZip }),
			),
		);
		return extracted.flatMap((item) => item.extractedPaths).length;
	}

	function resetConfirmState() {
		similarWarnings = [];
		awaitingConfirm = false;
	}

	function render() {
		// 選択状態の更新でもパネルを再描画するため、現在位置を引き継ぐ。
		// これがないと、下部の「すべて選択」を押した際にスクロール領域が先頭へ戻る。
		const previousScrollTop =
			panel.querySelector<HTMLElement>(".fuzzy-panel-scroll")?.scrollTop ?? 0;
		panel.classList.toggle("is-collapsed", !isPanelOpen);
		// 開閉ハンドルは開いている間だけ表示（閉じている間は「Fuzzy」タブで再オープン）。
		collapseHandle.style.display = isPanelOpen ? "grid" : "none";
		panel.innerHTML = "";

		if (!isPanelOpen) {
			panel.append(renderOpenTab());
			return;
		}

		// ヘッダー・各セクション・フッターは内側のスクロール領域に入れる。
		// こうするとパネル自身をoverflow:visibleにでき、左端のハンドルが隠れない。
		const scroll = document.createElement("div");
		scroll.className = "fuzzy-panel-scroll";
		scroll.append(renderHeader());
		if (message) scroll.append(renderNote());
		const selectedFiles = snapshot.files.filter((file) => selectedFileIds.has(fileId(file)));
		const zipFiles = selectedFiles.filter(isZipFile);
		scroll.append(renderFileList(snapshot.files));
		if (zipFiles.length > 0)
			scroll.append(renderZipSection(zipFiles.length, currentDestinationPath()));
		scroll.append(renderPathSection());
		if (awaitingConfirm && similarWarnings.length > 0) scroll.append(renderSimilarConfirm());
		scroll.append(renderActions(selectedFiles, zipFiles));

		panel.append(scroll);
		scroll.scrollTop = previousScrollTop;
	}

	function renderOpenTab() {
		const button = document.createElement("button");
		button.className = "fuzzy-panel-tab";
		button.type = "button";
		button.textContent = "Fuzzy";
		button.setAttribute("aria-label", "Fuzzyの一括保存パネルを開く");
		button.addEventListener("click", () => setPanelOpen(true));
		return button;
	}

	function renderHeader() {
		const header = document.createElement("div");
		header.className = "fuzzy-panel-header";
		const modePill =
			api.mode === "mock"
				? '<span class="fuzzy-pill fuzzy-pill-mock">サンプル</span>'
				: '<span class="fuzzy-pill">ブラウザ拡張</span>';
		header.innerHTML = `
			<div>
				<p><span class="fuzzy-logo">F</span><strong>Fuzzy</strong>${modePill}</p>
				<small>ダウンロードを検出・コース「${escapeHtml(snapshot.courseName ?? "未取得")}」</small>
			</div>
			<div class="fuzzy-panel-tools">
				<button type="button" data-action="refresh" aria-label="Fuzzyの資料一覧を更新">↻</button>
				<button type="button" data-action="collapse" aria-label="Fuzzyの一括保存パネルを閉じる">×</button>
			</div>
		`;
		header
			.querySelector<HTMLButtonElement>("[data-action='refresh']")
			?.addEventListener("click", () => void reloadSnapshotAndSuggestions());
		header
			.querySelector<HTMLButtonElement>("[data-action='collapse']")
			?.addEventListener("click", () => setPanelOpen(false));
		return header;
	}

	function renderNote() {
		const note = document.createElement("p");
		const busy = loading || saving || checkingSimilar;
		note.className = busy ? "fuzzy-note" : "fuzzy-note fuzzy-note-result";
		note.textContent = message ?? "";
		return note;
	}

	function renderFileList(files: MoodleFileLink[]) {
		const section = document.createElement("section");
		section.className = "fuzzy-section";
		const list = files
			.map((file) => {
				const type = fileTypeInfo(file);
				const title = displayFileTitle(file, type.label);
				const context = fileContextLabel(file, snapshot);
				return `
					<label class="fuzzy-file-row">
						<input type="checkbox" data-file-id="${escapeHtml(fileId(file))}" ${
							selectedFileIds.has(fileId(file)) ? "checked" : ""
						} />
						<span class="fuzzy-file-type" data-kind="${type.kind}">${escapeHtml(type.label)}</span>
						<span class="fuzzy-file-details">
							<strong>${escapeHtml(title)}</strong>
							<small>${escapeHtml(context)}</small>
						</span>
					</label>
				`;
			})
			.join("");
		section.innerHTML = `
			<div class="fuzzy-section-heading">
				<h3>保存できるファイル（このページ）</h3>
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
				onSelectionChanged();
			});
		}
		return section;
	}

	function renderPathSection() {
		const section = document.createElement("section");
		section.className = "fuzzy-section";
		const primarySuggestion = suggestions[0];
		const suggestionOptions = suggestions
			.slice(1)
			.map(
				(suggestion, index) => `
					<label class="fuzzy-path-option">
						<input type="radio" name="fuzzy-save-path" value="${escapeHtml(suggestion.path)}" ${
							isPathChecked(suggestion.path) ? "checked" : ""
						} />
						<span>
							<strong>${escapeHtml(displayPath(suggestion.path))}</strong>
							<small>候補 ${index + 2}位 · 一致度 ${Math.round(suggestion.confidence * 100)}%</small>
						</span>
					</label>
				`,
			)
			.join("");
		section.innerHTML = `
			<div class="fuzzy-section-heading"><h3>保存先（提案）</h3></div>
			${
				primarySuggestion
					? `<label class="fuzzy-path-feature">
						<input type="radio" name="fuzzy-save-path" value="${escapeHtml(primarySuggestion.path)}" ${
							isPathChecked(primarySuggestion.path) ? "checked" : ""
						} />
						<span>
							<strong>${escapeHtml(displayPath(primarySuggestion.path))}</strong>
							<small>候補 1位 · コースと資料情報から推定 · 一致度 ${Math.round(primarySuggestion.confidence * 100)}%</small>
						</span>
						<em>おすすめ</em>
					</label>`
					: "<p class='fuzzy-empty'>保存先候補はまだありません。</p>"
			}
			<div class="fuzzy-path-chips">
				<button type="button" data-action="use-suggested" ${primarySuggestion ? "" : "disabled"}>この候補を使う</button>
				<button type="button" data-action="use-last-path" ${lastSavePath ? "" : "disabled"}>前回と同じ場所</button>
			</div>
			<div class="fuzzy-path-list">${suggestions.length > 1 ? suggestionOptions : ""}</div>
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
				render();
			});
		}
		section
			.querySelector<HTMLButtonElement>("[data-action='use-suggested']")
			?.addEventListener("click", () => {
				if (primarySuggestion) selectedPath = primarySuggestion.path;
				manualPath = "";
				render();
			});
		section
			.querySelector<HTMLButtonElement>("[data-action='use-last-path']")
			?.addEventListener("click", () => {
				if (!lastSavePath) return;
				manualPath = lastSavePath;
				render();
			});
		// 入力欄はキー入力ごとに全再描画するとフォーカスを失うため、
		// 保存ボタンの活性状態とサマリだけを差分更新する（Copilot指摘#3への対応）。
		section
			.querySelector<HTMLInputElement>("[data-input='manual-path']")
			?.addEventListener("input", (event) => {
				manualPath = inputValue(event);
				updateActionState();
			});
		return section;
	}

	function renderZipSection(zipCount: number, destinationPath: string) {
		const section = document.createElement("section");
		section.className = "fuzzy-section fuzzy-zip-section";
		section.innerHTML = `
			<div class="fuzzy-section-heading"><h3>ZIP の扱い</h3><span>${zipCount}件</span></div>
			<p class="fuzzy-section-description">ZIP を展開するか、そのまま保存するかを先に選べます。</p>
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
				render();
			});
		}
		section
			.querySelector<HTMLInputElement>("[data-input='flatten-zip']")
			?.addEventListener("change", (event) => {
				flattenZip = inputChecked(event);
			});
		// 展開先もキー入力ごとの全再描画を避け、サマリのみ差分更新する（Copilot指摘#4への対応）。
		section
			.querySelector<HTMLInputElement>("[data-input='extract-path']")
			?.addEventListener("input", (event) => {
				extractDestinationPath = inputValue(event);
				updateActionState();
			});
		return section;
	}

	function renderSimilarConfirm() {
		const section = document.createElement("section");
		section.className = "fuzzy-section";
		const rows = similarWarnings
			.map(
				(warning) => `
					<div class="fuzzy-similar-row">
						<strong>${escapeHtml(warning.file.title)}</strong>
						<small>類似: ${escapeHtml(warning.match.originalName)}（${Math.round(warning.match.similarity * 100)}%）</small>
					</div>
				`,
			)
			.join("");
		section.innerHTML = `
			<div class="fuzzy-section-heading"><h3>似た資料が見つかりました</h3><span>${similarWarnings.length}件</span></div>
			<p class="fuzzy-note fuzzy-note-warning">すでに保存済みの可能性があります。続行すると重複して保存されます。</p>
			<div class="fuzzy-similar-list">${rows}</div>
			<div class="fuzzy-confirm-buttons">
				<button type="button" data-action="cancel-save">キャンセル</button>
				<button type="button" data-action="confirm-save">このまま保存</button>
			</div>
		`;
		section
			.querySelector<HTMLButtonElement>("[data-action='cancel-save']")
			?.addEventListener("click", () => {
				resetConfirmState();
				message = "保存を中止しました。";
				render();
			});
		section
			.querySelector<HTMLButtonElement>("[data-action='confirm-save']")
			?.addEventListener("click", () => void saveSelectedFiles(true));
		return section;
	}

	function renderActions(selectedFiles: MoodleFileLink[], zipFiles: MoodleFileLink[]) {
		const actions = document.createElement("div");
		actions.className = "fuzzy-actions";
		const targetPath = currentTargetPath();
		const allSelected = snapshot.files.length > 0 && selectedFileIds.size === snapshot.files.length;
		const canSave =
			selectedFiles.length > 0 && targetPath.length > 0 && !saving && !checkingSimilar;
		actions.innerHTML = `
			<p data-role="save-summary">${escapeHtml(buildSummaryText(selectedFiles, zipFiles, targetPath, currentDestinationPath()))}</p>
			<div class="fuzzy-action-meta">
				<button type="button" class="fuzzy-toggle-all-button" data-action="toggle-all-footer">
					<span aria-hidden="true">${allSelected ? "✓" : "+"}</span>
					${allSelected ? "すべて解除" : "すべて選択"}
				</button>
				<span>選択中: ${selectedFiles.length}件</span>
			</div>
			<button type="button" data-action="save" ${canSave ? "" : "disabled"}>
				${saving ? "保存中" : checkingSimilar ? "照合中" : "選んだ場所にダウンロード"}
			</button>
		`;
		actions
			.querySelector<HTMLButtonElement>("[data-action='save']")
			?.addEventListener("click", () => void saveSelectedFiles());
		actions
			.querySelector<HTMLButtonElement>("[data-action='toggle-all-footer']")
			?.addEventListener("click", () => toggleAllFiles(snapshot.files));
		return actions;
	}

	// --- 状態更新ヘルパー ---

	function setPanelOpen(open: boolean) {
		if (isPanelOpen === open) return;
		isPanelOpen = open;
		void savePanelOpenState(open);
		render();
	}

	function onSelectionChanged() {
		resetConfirmState(); // 選択が変われば前回の類似判定は無効化し、再チェックさせる
		message = null;
		render();
	}

	function toggleAllFiles(files: MoodleFileLink[]) {
		if (selectedFileIds.size === files.length) selectedFileIds.clear();
		else selectedFileIds = new Set(files.map(fileId));
		onSelectionChanged();
	}

	function updateActionState() {
		const selectedFiles = snapshot.files.filter((file) => selectedFileIds.has(fileId(file)));
		const zipFiles = selectedFiles.filter(isZipFile);
		const targetPath = currentTargetPath();
		const canSave =
			selectedFiles.length > 0 && targetPath.length > 0 && !saving && !checkingSimilar;
		panel
			.querySelector<HTMLButtonElement>("[data-action='save']")
			?.toggleAttribute("disabled", !canSave);
		const summary = panel.querySelector<HTMLElement>("[data-role='save-summary']");
		if (summary) {
			summary.textContent = buildSummaryText(
				selectedFiles,
				zipFiles,
				targetPath,
				currentDestinationPath(),
			);
		}
	}

	function buildSummaryText(
		selectedFiles: MoodleFileLink[],
		zipFiles: MoodleFileLink[],
		targetPath: string,
		destinationPath: string,
	): string {
		if (selectedFiles.length === 0) return "保存する資料を選択してください。";
		if (targetPath.length === 0) return "保存先を選択してください。";
		if (zipFiles.length > 0 && zipMode === "extract") {
			return `${selectedFiles.length}件を保存し、ZIP ${zipFiles.length}件を ${displayPath(destinationPath)} に展開します。`;
		}
		return `${selectedFiles.length}件を ${displayPath(targetPath)} に保存します。`;
	}

	function currentTargetPath(): string {
		return manualPath.trim() || selectedPath;
	}

	function currentDestinationPath(): string {
		return extractDestinationPath.trim() || currentTargetPath();
	}

	function isPathChecked(path: string): boolean {
		return selectedPath === path && manualPath.trim() === "";
	}

	function injectPanelStyle() {
		if (document.getElementById(SAVE_PANEL_STYLE_ID)) return;
		const style = document.createElement("style");
		style.id = SAVE_PANEL_STYLE_ID;
		style.textContent = SAVE_PANEL_STYLE;
		document.head.append(style);
	}
}

async function loadSuggestions(api: BackgroundApiClient, snapshot: MoodlePageSnapshot) {
	return api.suggestSavePath({
		course: {
			name: snapshot.courseName,
			sectionTitle: snapshot.sectionTitle,
			breadcrumbs: snapshot.breadcrumbs,
		},
		fileMeta: snapshot.files[0] ?? null,
	});
}

async function loadLastSavePath(): Promise<string> {
	try {
		const stored = await browser.storage.local.get(LAST_SAVE_PATH_KEY);
		const value = stored[LAST_SAVE_PATH_KEY];
		return typeof value === "string" ? value : "";
	} catch {
		return "";
	}
}

async function saveLastSavePath(path: string): Promise<void> {
	try {
		await browser.storage.local.set({ [LAST_SAVE_PATH_KEY]: path });
	} catch (error) {
		console.warn("[fuzzy] 保存先の記憶に失敗しました", error);
	}
}

async function loadPanelOpenState(): Promise<boolean> {
	try {
		const stored = await browser.storage.local.get(SAVE_PANEL_OPEN_STATE_KEY);
		return stored[SAVE_PANEL_OPEN_STATE_KEY] === true;
	} catch {
		return false;
	}
}

async function savePanelOpenState(isOpen: boolean): Promise<void> {
	try {
		await browser.storage.local.set({ [SAVE_PANEL_OPEN_STATE_KEY]: isOpen });
	} catch (error) {
		console.warn("[fuzzy] 保存パネルの開閉状態の記憶に失敗しました", error);
	}
}

function toErrorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? `${fallback}: ${error.message}` : `${fallback}。`;
}

function fileId(file: MoodleFileLink): string {
	return file.url;
}

function fileType(file: MoodleFileLink): string {
	return (
		fileExtensionFromMimeHint(file.mimeHint) ??
		fileExtensionFromName(file.title) ??
		fileExtensionFromName(file.url) ??
		"file"
	);
}

function isZipFile(file: MoodleFileLink): boolean {
	return fileType(file) === "zip" || /\.zip(?:$|[?#])/i.test(file.url);
}

function rankSuggestions(suggestions: SaveSuggestion[]): SaveSuggestion[] {
	return [...suggestions]
		.filter(
			(suggestion, index, all) => all.findIndex((item) => item.path === suggestion.path) === index,
		)
		.sort((a, b) => b.confidence - a.confidence);
}

function fileTypeInfo(file: MoodleFileLink): { kind: string; label: string } {
	const kind = fileType(file).toLowerCase();
	if (kind === "pdf") return { kind, label: "PDF" };
	if (["doc", "docx"].includes(kind)) return { kind: "document", label: kind.toUpperCase() };
	if (["ppt", "pptx"].includes(kind)) return { kind: "presentation", label: kind.toUpperCase() };
	if (["xls", "xlsx", "csv"].includes(kind))
		return { kind: "spreadsheet", label: kind.toUpperCase() };
	if (kind === "zip") return { kind, label: "ZIP" };
	if (["png", "jpg", "jpeg", "gif", "webp"].includes(kind))
		return { kind: "image", label: kind.toUpperCase() };
	return { kind: "other", label: /^[a-z0-9]{1,10}$/.test(kind) ? kind.toUpperCase() : "FILE" };
}

function fileExtensionFromMimeHint(mimeHint: string | null): string | null {
	const value = mimeHint?.trim().toLowerCase() ?? "";
	// Moodle の pluginfile.php / resource/view.php はダウンロードURLの経路であり、
	// 資料のファイル形式ではない。アイコンなど別の情報が取れない限り表示に使わない。
	if (value === "php") return null;
	if (/^[a-z0-9]{1,10}$/.test(value)) return value;

	const mimeTypeExtensions: Record<string, string> = {
		"application/pdf": "pdf",
		"application/zip": "zip",
		"application/vnd.google-earth.kmz": "kmz",
		"application/vnd.google-earth.kml+xml": "kml",
		"application/gpx+xml": "gpx",
		"application/vnd.ms-excel": "xls",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
		"image/jpeg": "jpg",
	};
	return mimeTypeExtensions[value] ?? null;
}

function fileExtensionFromName(value: string): string | null {
	const extension = value.match(/\.([a-z0-9]{1,10})(?:$|[?#])/i)?.[1]?.toLowerCase();
	return extension === "php" ? null : (extension ?? null);
}

function displayFileTitle(file: MoodleFileLink, extensionLabel: string): string {
	const extension = fileExtensionFromName(file.title);
	if (!extension || extension.toUpperCase() !== extensionLabel) return file.title;
	return file.title.replace(new RegExp(`\\.${extension}$`, "i"), "");
}

/** 同名ファイルを見分けられるよう、Moodle上の回・項目などの所属を表示する。 */
function fileContextLabel(file: MoodleFileLink, snapshot: MoodlePageSnapshot): string {
	const labels = [file.sectionTitle, snapshot.sectionTitle]
		.map(displayableSectionLabel)
		.filter((label, index, all) => label.length > 0 && all.indexOf(label) === index);
	// 回・お知らせとして判別できない資料も、補足欄は常に表示する。
	// その場合は活動名やファイル名ではなく、Moodle の既定セクション名として「一般」を使う。
	return labels[0] ?? "一般";
}

/** ファイル名・容量ではなく、取得済みのMoodleセクション名だけを表示する。 */
function displayableSectionLabel(value: string | null): string {
	return value?.trim().replace(/\s+/g, " ") ?? "";
}

function displayPath(path: string): string {
	return path.replace(/[\\/]+/g, "\\");
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
