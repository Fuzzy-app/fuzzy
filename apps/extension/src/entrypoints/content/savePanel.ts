// Fuzzy保存パネル（issue48〜51: 資料検出・保存先サジェスト・一括保存・ZIP展開提案・類似ファイル通知）。
// mainのcontent/モジュール分割方針に合わせ、このモジュールはDOM構築のみを担当する。
// スナップショット収集は ../../lib/moodle/snapshotCollector、
// native-host接続は background 経由（../../lib/api/backgroundApi）に委譲する。
import {
	type SimilarFileMatch,
	normalizeRelativeSavePath,
	relativeSavePath,
	resolveSavePathUnderRoot,
	splitWindowsPath,
} from "@fuzzy/shared";
import { BackgroundApiClient } from "../../lib/api/backgroundApi";
import { displayFileTitle, fileTypeInfo, isZipFile } from "../../lib/moodle/fileType";
import type { MoodleFileLink } from "../../lib/moodle/pageSnapshot";
import {
	collectMoodlePageSnapshotWithNestedFolders,
	safeCollectMoodlePageSnapshot,
} from "../../lib/moodle/snapshotCollector";
import { createSavePanelOpenStateWriter, loadSavePanelOpenState } from "./savePanelState";
import {
	SAVE_HANDLE_ID,
	SAVE_PANEL_ID,
	SAVE_PANEL_STYLE,
	SAVE_PANEL_STYLE_ID,
} from "./savePanelStyle";
import {
	type FileSuggestions,
	type SaveDestinationGroup,
	type SelectedFilePaths,
	buildSaveDestinationGroups,
	commonGroupSuggestions,
	createSelectedFilePaths,
	fileId,
	loadFileSuggestions,
	saveRootFromSuggestions,
} from "./savePlan";

/** 直近の保存先を記憶しておくstorageキー（「前回と同じ場所」で再利用する）。 */
const LAST_SAVE_PATH_KEY = "fuzzy:lastSavePath";

interface SimilarWarning {
	file: MoodleFileLink;
	match: SimilarFileMatch;
}

export async function mountSavePanel(): Promise<void> {
	document.getElementById(SAVE_PANEL_ID)?.remove();
	document.getElementById(SAVE_HANDLE_ID)?.remove();

	const panel = document.createElement("aside");
	panel.id = SAVE_PANEL_ID;
	panel.setAttribute("aria-label", "Fuzzy 資料一括保存");
	panel.hidden = true;
	document.body.append(panel);

	// 開閉ハンドル（›）はパネル本体のoverflowにクリップされないよう、
	// パネルとは別に body 直下へ固定配置する（パネル左端のすぐ外側に表示）。
	const collapseHandle = document.createElement("button");
	collapseHandle.id = SAVE_HANDLE_ID;
	collapseHandle.type = "button";
	collapseHandle.textContent = "›";
	collapseHandle.setAttribute("aria-label", "Fuzzyの一括保存パネルを閉じる");
	collapseHandle.addEventListener("click", () => setPanelOpen(false));
	collapseHandle.style.display = "none";
	document.body.append(collapseHandle);

	const api = new BackgroundApiClient();
	let snapshot = safeCollectMoodlePageSnapshot();
	let suggestions: FileSuggestions = new Map();
	let selectedFileIds = new Set(snapshot.files.map(fileId));
	let selectedPaths: SelectedFilePaths = new Map();
	let manualRelativePath = "";
	let lastSavePath = "";
	let zipMode: "extract" | "keep" = "extract";
	let flattenZip = true;
	let extractDestinationRelativePath = "";
	// 類似ファイル通知（issue51）: 保存前チェックの状態。
	let similarWarnings: SimilarWarning[] = [];
	let checkingSimilar = false;
	let awaitingConfirm = false;
	let initialized = false;
	let loading = false;
	let saving = false;
	let isPanelOpen = false;
	let message: string | null = null;
	const savePanelOpenState = createSavePanelOpenStateWriter(browser.storage.local);

	injectPanelStyle();
	isPanelOpen = await loadSavePanelOpenState(browser.storage.local);
	// 開閉状態の読み込み中に再マウントされた場合、古いインスタンスは初期化しない。
	if (document.getElementById(SAVE_PANEL_ID) !== panel) return;
	panel.hidden = false;
	if (isPanelOpen) startInitialization();
	else render();

	async function initialize() {
		try {
			const [fullSnapshot, storedPath] = await Promise.all([
				collectMoodlePageSnapshotWithNestedFolders(),
				loadLastSavePath(),
			]);
			snapshot = fullSnapshot;
			lastSavePath = storedPath;
			selectedFileIds = new Set(snapshot.files.map(fileId));
			suggestions = await loadFileSuggestions(api, snapshot);
			selectedPaths = createSelectedFilePaths(suggestions);
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
			suggestions = await loadFileSuggestions(api, snapshot);
			selectedPaths = createSelectedFilePaths(suggestions);
			manualRelativePath = "";
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

		const groups = currentSaveGroups();
		const selectedFiles = groups.flatMap((group) => group.files);
		if (selectedFiles.length === 0 || groups.length === 0) return;

		if (!confirmed && !(await ensureSimilarChecked(selectedFiles))) {
			return; // 類似あり→確認待ちで一旦中断
		}

		saving = true;
		awaitingConfirm = false;
		message = "保存処理を実行しています。";
		render();
		let savedCount = 0;
		let extractedCount = 0;
		let failedDestinationCount = 0;
		let failedZipCount = 0;
		for (const group of groups) {
			try {
				const result = await api.saveFiles({ files: group.files, targetPath: group.path });
				savedCount += result.savedFileIds.length;
				const extraction = await extractSelectedZips(group);
				extractedCount += extraction.extractedCount;
				failedZipCount += extraction.failedCount;
			} catch (error) {
				failedDestinationCount += 1;
				console.error("[fuzzy] 保存先グループの保存に失敗しました", {
					relativePath: group.relativePath,
					error,
				});
			}
		}
		if (groups.length === 1 && failedDestinationCount === 0) {
			await saveLastSavePath(groups[0]?.path ?? "");
			lastSavePath = groups[0]?.path ?? "";
		}
		similarWarnings = [];
		if (failedDestinationCount > 0) {
			message = `${savedCount}件は保存しましたが、${failedDestinationCount}か所の保存に失敗しました。再試行してください。`;
		} else if (failedZipCount > 0) {
			message = `${savedCount}件を保存しましたが、ZIP ${failedZipCount}件の展開に失敗しました。`;
		} else {
			message =
				extractedCount > 0
					? `${savedCount}件を${groups.length}か所に保存し、ZIPから${extractedCount}件を展開しました。`
					: `${savedCount}件の資料を${groups.length}か所に保存しました。`;
		}
		saving = false;
		render();
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

	async function extractSelectedZips(
		group: SaveDestinationGroup,
	): Promise<{ extractedCount: number; failedCount: number }> {
		if (zipMode !== "extract") return { extractedCount: 0, failedCount: 0 };
		const zipFiles = group.files.filter(isZipFile);
		if (zipFiles.length === 0) return { extractedCount: 0, failedCount: 0 };

		const destinationPath = currentExtractDestinationPath() ?? group.path;
		const extracted = await Promise.allSettled(
			zipFiles.map((file) =>
				api.extractZip({
					fileMeta: file,
					targetPath: group.path,
					destinationPath,
					flatten: flattenZip,
				}),
			),
		);
		return {
			extractedCount: extracted
				.filter((item) => item.status === "fulfilled")
				.flatMap((item) => item.value.extractedPaths).length,
			failedCount: extracted.filter((item) => item.status === "rejected").length,
		};
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
		if (zipFiles.length > 0) scroll.append(renderZipSection(zipFiles.length));
		scroll.append(renderPathSection());
		if (awaitingConfirm && similarWarnings.length > 0) scroll.append(renderSimilarConfirm());
		scroll.append(renderActions(selectedFiles, zipFiles, currentSaveGroups()));

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
				return `
					<label class="fuzzy-file-row">
						<input type="checkbox" data-file-id="${escapeHtml(fileId(file))}" ${
							selectedFileIds.has(fileId(file)) ? "checked" : ""
						} />
						<span class="fuzzy-file-type" data-kind="${type.kind}">${escapeHtml(type.label)}</span>
						<span class="fuzzy-file-details">
							<strong>${escapeHtml(title)}</strong>
							<small>${escapeHtml(file.sectionTitle ?? "セクション未取得")}</small>
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
		const groups = currentSaveGroups();
		const root = saveRootFromSuggestions(suggestions);
		const lastRelativePath = root && lastSavePath ? relativeSavePath(root, lastSavePath) : null;
		const invalidManualPath =
			manualRelativePath.trim().length > 0 && currentManualDestination() === null;
		const groupCards = groups
			.map((group, index) => {
				const commonSuggestions = commonGroupSuggestions(group, suggestions);
				const fileNames = group.files.map((file) => `<li>${escapeHtml(file.title)}</li>`).join("");
				const candidateSelect =
					manualRelativePath.trim() || commonSuggestions.length < 2
						? ""
						: `<label class="fuzzy-destination-select">
							<span>別の候補</span>
							<select data-group-key="${escapeHtml(group.key)}">
								${commonSuggestions
									.map(
										(candidate, candidateIndex) =>
											`<option value="${escapeHtml(candidate.path)}" ${
												candidate.path === group.path ? "selected" : ""
											}>候補 ${candidateIndex + 1}（一致度 ${Math.round(candidate.confidence * 100)}%）</option>`,
									)
									.join("")}
							</select>
						</label>`;
				return `<article class="fuzzy-destination-group">
					<div class="fuzzy-destination-heading">
						<strong>保存先 ${index + 1}</strong>
						<span>${group.files.length}件</span>
					</div>
					${renderPathBreadcrumb(group.relativePath)}
					<ul>${fileNames}</ul>
					${candidateSelect}
				</article>`;
			})
			.join("");
		section.innerHTML = `
			<div class="fuzzy-section-heading"><h3>保存先（資料別）</h3><span>${groups.length}か所</span></div>
			<p class="fuzzy-section-description">推奨先が同じ資料をまとめ、保存先ごとに分けて保存します。</p>
			<div class="fuzzy-destination-list">${
				groupCards || "<p class='fuzzy-empty'>保存先候補はまだありません。</p>"
			}</div>
			<div class="fuzzy-path-chips">
				<button type="button" data-action="use-suggested" ${suggestions.size ? "" : "disabled"}>提案に戻す</button>
				<button type="button" data-action="use-last-path" ${lastRelativePath === null ? "disabled" : ""}>前回と同じ場所</button>
			</div>
			<label class="fuzzy-input">
				<span>手動でまとめる（保存ルート以下、区切りは / ）</span>
				<input type="text" data-input="manual-path" value="${escapeHtml(manualRelativePath)}" placeholder="2026前期/データベース/第4回" aria-invalid="${invalidManualPath}" />
				${invalidManualPath ? '<small class="fuzzy-input-error">保存ルート以下の有効なフォルダを指定してください。</small>' : ""}
			</label>
		`;
		for (const select of section.querySelectorAll<HTMLSelectElement>("select[data-group-key]")) {
			select.addEventListener("change", () => {
				const group = currentSaveGroups().find((item) => item.key === select.dataset.groupKey);
				if (!group) return;
				for (const file of group.files) selectedPaths.set(fileId(file), select.value);
				manualRelativePath = "";
				render();
			});
		}
		section
			.querySelector<HTMLButtonElement>("[data-action='use-suggested']")
			?.addEventListener("click", () => {
				selectedPaths = createSelectedFilePaths(suggestions);
				manualRelativePath = "";
				render();
			});
		section
			.querySelector<HTMLButtonElement>("[data-action='use-last-path']")
			?.addEventListener("click", () => {
				if (lastRelativePath === null) return;
				manualRelativePath = displayEditablePath(lastRelativePath);
				render();
			});
		const manualInput = section.querySelector<HTMLInputElement>("[data-input='manual-path']");
		manualInput?.addEventListener("input", (event) => {
			manualRelativePath = inputValue(event);
			updateActionState();
		});
		manualInput?.addEventListener("change", () => {
			manualRelativePath = displayEditablePath(manualRelativePath);
			render();
		});
		return section;
	}

	function renderZipSection(zipCount: number) {
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
				<span>展開先（保存ルート以下、空欄なら各資料の保存先）</span>
				<input type="text" data-input="extract-path" value="${escapeHtml(extractDestinationRelativePath)}" ${
					zipMode === "keep" ? "disabled" : ""
				} placeholder="各資料の保存先と同じフォルダ" />
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
		const extractInput = section.querySelector<HTMLInputElement>("[data-input='extract-path']");
		extractInput?.addEventListener("input", (event) => {
			extractDestinationRelativePath = inputValue(event);
			updateActionState();
		});
		extractInput?.addEventListener("change", () => {
			extractDestinationRelativePath = displayEditablePath(extractDestinationRelativePath);
			render();
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

	function renderActions(
		selectedFiles: MoodleFileLink[],
		zipFiles: MoodleFileLink[],
		groups: SaveDestinationGroup[],
	) {
		const actions = document.createElement("div");
		actions.className = "fuzzy-actions";
		const allSelected = snapshot.files.length > 0 && selectedFileIds.size === snapshot.files.length;
		const canSave =
			selectedFiles.length > 0 &&
			groups.flatMap((group) => group.files).length === selectedFiles.length &&
			isExtractDestinationValid() &&
			!loading &&
			!saving &&
			!checkingSimilar;
		actions.innerHTML = `
			<p data-role="save-summary">${escapeHtml(buildSummaryText(selectedFiles, zipFiles, groups))}</p>
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
		if (open && !initialized) {
			startInitialization();
			return;
		}
		render();
	}

	function startInitialization() {
		if (initialized) return;
		initialized = true;
		loading = true;
		message = "Moodleページ内の資料を読み込んでいます。";
		render();
		void initialize();
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
		const groups = currentSaveGroups();
		const canSave =
			selectedFiles.length > 0 &&
			groups.flatMap((group) => group.files).length === selectedFiles.length &&
			isExtractDestinationValid() &&
			!loading &&
			!saving &&
			!checkingSimilar;
		panel
			.querySelector<HTMLButtonElement>("[data-action='save']")
			?.toggleAttribute("disabled", !canSave);
		const summary = panel.querySelector<HTMLElement>("[data-role='save-summary']");
		if (summary) {
			summary.textContent = buildSummaryText(selectedFiles, zipFiles, groups);
		}
	}

	function buildSummaryText(
		selectedFiles: MoodleFileLink[],
		zipFiles: MoodleFileLink[],
		groups: SaveDestinationGroup[],
	): string {
		if (selectedFiles.length === 0) return "保存する資料を選択してください。";
		if (groups.flatMap((group) => group.files).length !== selectedFiles.length) {
			return manualRelativePath.trim()
				? "保存ルート以下の有効なフォルダを指定してください。"
				: "すべての資料の保存先を選択してください。";
		}
		if (!isExtractDestinationValid()) {
			return "ZIPの展開先は保存ルート以下で指定してください。";
		}
		if (zipFiles.length > 0 && zipMode === "extract") {
			const destination = extractDestinationRelativePath.trim()
				? displayRelativePath(extractDestinationRelativePath)
				: "各資料の保存先";
			return `${selectedFiles.length}件を${groups.length}か所に保存し、ZIP ${zipFiles.length}件を「${destination}」へ展開します。`;
		}
		if (groups.length === 1) {
			return `${selectedFiles.length}件を「${displayRelativePath(groups[0]?.relativePath ?? "")}」へ保存します。`;
		}
		return `${selectedFiles.length}件を保存先別の${groups.length}か所へ分けて保存します。`;
	}

	function currentSaveGroups(): SaveDestinationGroup[] {
		if (manualRelativePath.trim()) {
			const destination = currentManualDestination();
			if (!destination) return [];
			return buildSaveDestinationGroups(
				snapshot.files,
				selectedFileIds,
				suggestions,
				selectedPaths,
				destination,
			);
		}
		return buildSaveDestinationGroups(snapshot.files, selectedFileIds, suggestions, selectedPaths);
	}

	function currentManualDestination(): { path: string; relativePath: string } | null {
		const root = saveRootFromSuggestions(suggestions);
		const relativePath = normalizeRelativeSavePath(manualRelativePath);
		if (!root || relativePath === null || !relativePath) return null;
		const path = resolveSavePathUnderRoot(root, relativePath);
		return path ? { path, relativePath } : null;
	}

	function currentExtractDestinationPath(): string | null {
		if (!extractDestinationRelativePath.trim()) return null;
		const root = saveRootFromSuggestions(suggestions);
		return root ? resolveSavePathUnderRoot(root, extractDestinationRelativePath) : null;
	}

	function isExtractDestinationValid(): boolean {
		return (
			zipMode === "keep" ||
			!extractDestinationRelativePath.trim() ||
			currentExtractDestinationPath() !== null
		);
	}

	function injectPanelStyle() {
		if (document.getElementById(SAVE_PANEL_STYLE_ID)) return;
		const style = document.createElement("style");
		style.id = SAVE_PANEL_STYLE_ID;
		style.textContent = SAVE_PANEL_STYLE;
		document.head.append(style);
	}
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

function toErrorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? `${fallback}: ${error.message}` : `${fallback}。`;
}

function renderPathBreadcrumb(relativePath: string): string {
	const segments = splitWindowsPath(relativePath);
	const crumbs = ["保存ルート", ...segments]
		.map(
			(segment, index) =>
				`${index > 0 ? '<span class="fuzzy-path-separator" aria-hidden="true">›</span>' : ""}<span class="fuzzy-path-segment">${escapeHtml(segment)}</span>`,
		)
		.join("");
	return `<div class="fuzzy-path-breadcrumb" role="navigation" aria-label="保存先: ${escapeHtml(
		["保存ルート", ...segments].join("、"),
	)}">${crumbs}</div>`;
}

function displayRelativePath(path: string): string {
	const segments = splitWindowsPath(path);
	return segments.length > 0 ? segments.join(" › ") : "保存ルート";
}

function displayEditablePath(path: string): string {
	return normalizeRelativeSavePath(path) === null ? path : splitWindowsPath(path).join("/");
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
