<script lang="ts">
	import { onMount } from "svelte";
	import {
		createApiClient,
		type FuzzyApiClient,
		type SaveSuggestion,
	} from "@fuzzy/shared";
	import {
		MOODLE_PAGE_SNAPSHOT_MESSAGE,
		type MoodleFileLink,
		type MoodlePageSnapshot,
	} from "../../lib/moodle/pageSnapshot";

	interface LoadState {
		loading: boolean;
		error: string | null;
	}

	let api: FuzzyApiClient | null = null;
	let apiMode: "native" | "mock" | "loading" = "loading";
	let snapshot: MoodlePageSnapshot | null = null;
	let suggestions: SaveSuggestion[] = [];
	let selectedFileIds: string[] = [];
	let selectedPath = "";
	let manualPath = "";
	let resultMessage: string | null = null;
	let saving = false;
	let state: LoadState = { loading: true, error: null };

	$: files = snapshot?.files ?? [];
	$: selectedFiles = files.filter((file) =>
		selectedFileIds.includes(fileId(file)),
	);
	$: effectivePath = manualPath.trim() || selectedPath;
	$: canSave = selectedFiles.length > 0 && effectivePath.length > 0 && !saving;

	onMount(() => {
		loadSaveSuggestionView();
	});

	async function loadSaveSuggestionView() {
		state = { loading: true, error: null };
		resultMessage = null;

		try {
			api = await createApiClient();
			apiMode = api.mode;
			snapshot = await requestActiveTabSnapshot();

			if (!snapshot) {
				state = {
					loading: false,
					error: "Moodleページを開いた状態で、もう一度Fuzzyを開いてください。",
				};
				return;
			}

			selectedFileIds = snapshot.files.map(fileId);
			suggestions = await api.suggestSavePath({
				course: {
					name: snapshot.courseName,
					sectionTitle: snapshot.sectionTitle,
					breadcrumbs: snapshot.breadcrumbs,
				},
				fileMeta: snapshot.files[0] ?? null,
			});
			selectedPath = suggestions[0]?.path ?? "";
			state = { loading: false, error: null };
		} catch (error) {
			state = {
				loading: false,
				error:
					error instanceof Error
						? error.message
						: "保存先候補の取得に失敗しました。",
			};
		}
	}

	async function requestActiveTabSnapshot(): Promise<MoodlePageSnapshot | null> {
		const runtime = getChromeRuntime();
		const tabsApi = runtime?.tabs;
		if (!tabsApi?.query || !tabsApi.sendMessage) return null;

		const tabs = await new Promise<Array<{ id?: number }>>((resolve) => {
			tabsApi.query?.({ active: true, currentWindow: true }, resolve);
		});
		const tabId = tabs[0]?.id;
		if (tabId === undefined) return null;

		return new Promise((resolve) => {
			tabsApi.sendMessage?.(
				tabId,
				{ type: MOODLE_PAGE_SNAPSHOT_MESSAGE },
				(response) => {
					resolve(response?.snapshot ?? null);
				},
			);
		});
	}

	function toggleFile(file: MoodleFileLink, checked: boolean) {
		const id = fileId(file);
		selectedFileIds = checked
			? Array.from(new Set([...selectedFileIds, id]))
			: selectedFileIds.filter((selectedId) => selectedId !== id);
		resultMessage = null;
	}

	function selectSuggestion(path: string) {
		selectedPath = path;
		manualPath = "";
		resultMessage = null;
	}

	async function saveSelectedFiles() {
		if (!api || !canSave) return;

		saving = true;
		resultMessage = null;
		try {
			const result = await api.saveFiles({
				files: selectedFiles,
				targetPath: effectivePath,
			});
			resultMessage = `${result.savedFileIds.length}件の資料を保存しました。`;
		} catch (error) {
			resultMessage =
				error instanceof Error
					? `保存に失敗しました: ${error.message}`
					: "保存に失敗しました。";
		} finally {
			saving = false;
		}
	}

	function fileId(file: MoodleFileLink): string {
		return file.moodleFileId ?? file.url;
	}

	function fileType(file: MoodleFileLink): string {
		return (
			file.mimeHint ?? file.title.split(".").pop()?.toLowerCase() ?? "file"
		);
	}

	function confidencePercent(suggestion: SaveSuggestion): number {
		return Math.round(suggestion.confidence * 100);
	}

	function getChromeRuntime():
		| {
				tabs?: {
					query?: (
						queryInfo: { active: boolean; currentWindow: boolean },
						callback: (tabs: Array<{ id?: number }>) => void,
					) => void;
					sendMessage?: (
						tabId: number,
						message: { type: string },
						callback: (response?: { snapshot?: MoodlePageSnapshot }) => void,
					) => void;
				};
		  }
		| undefined {
		// biome-ignore lint/suspicious/noExplicitAny: 拡張機能のchrome APIはブラウザが注入するため
		return (globalThis as any).chrome;
	}
</script>

<main>
	<header class="topbar">
		<div>
			<p class="eyebrow">保存先サジェスト</p>
			<h1>資料の保存先を選ぶ</h1>
		</div>
		<p class="mode" data-mode={apiMode}>
			{apiMode === "loading"
				? "接続確認中"
				: apiMode === "native"
					? "native-host接続中"
					: "サンプルデータ"}
		</p>
	</header>

	{#if state.loading}
		<section class="empty">
			<p>保存先候補を読み込んでいます。</p>
		</section>
	{:else if state.error}
		<section class="empty error">
			<p>{state.error}</p>
			<button type="button" on:click={loadSaveSuggestionView}>再読み込み</button
			>
		</section>
	{:else if snapshot}
		<section class="course-summary">
			<div>
				<span>コース</span>
				<strong>{snapshot.courseName ?? "不明なコース"}</strong>
			</div>
			<div>
				<span>回・セクション</span>
				<strong>{snapshot.sectionTitle ?? "未取得"}</strong>
			</div>
			<div>
				<span>資料</span>
				<strong>{files.length}件</strong>
			</div>
		</section>

		<div class="layout">
			<section class="panel" aria-label="保存対象ファイル">
				<div class="panel-header">
					<h2>保存する資料</h2>
					<span>{selectedFiles.length}件選択中</span>
				</div>

				<div class="file-list">
					{#each files as file (fileId(file))}
						<label class="file-row">
							<input
								type="checkbox"
								checked={selectedFileIds.includes(fileId(file))}
								on:change={(event) =>
									toggleFile(file, event.currentTarget.checked)}
							/>
							<span class="file-type">{fileType(file).toUpperCase()}</span>
							<span class="file-main">
								<strong>{file.title}</strong>
								<small
									>{file.sectionTitle ??
										snapshot.sectionTitle ??
										"セクション未取得"}</small
								>
							</span>
						</label>
					{/each}
				</div>
			</section>

			<section class="panel" aria-label="保存先候補">
				<div class="panel-header">
					<h2>保存先候補</h2>
					<span>確からしさ順</span>
				</div>

				<div class="suggestion-list">
					{#each suggestions as suggestion (suggestion.path)}
						<label
							class:selected={selectedPath === suggestion.path &&
								manualPath.trim() === ""}
							class="suggestion-option"
						>
							<input
								type="radio"
								name="savePath"
								checked={selectedPath === suggestion.path &&
									manualPath.trim() === ""}
								on:change={() => selectSuggestion(suggestion.path)}
							/>
							<span>
								<strong>{suggestion.path}</strong>
								<span class="confidence">
									<span class="confidence-bar">
										<span
											class="confidence-fill"
											style={`width: ${confidencePercent(suggestion)}%`}
										></span>
									</span>
									<small>{confidencePercent(suggestion)}%</small>
								</span>
							</span>
						</label>
					{/each}
				</div>

				<label class="manual-box">
					<span>手動で指定</span>
					<input
						bind:value={manualPath}
						type="text"
						placeholder="C:\Users\sample\Documents\大学\2026前期\データベース"
					/>
				</label>

				<div class="action-panel">
					<p class="save-summary">
						{#if selectedFiles.length === 0}
							保存する資料を選択してください。
						{:else if !effectivePath}
							保存先を選択してください。
						{:else}
							{selectedFiles.length}件を {effectivePath} に保存します。
						{/if}
					</p>
					<button
						type="button"
						disabled={!canSave}
						on:click={saveSelectedFiles}
					>
						{saving ? "保存中" : "選択した資料を保存"}
					</button>
					{#if resultMessage}
						<p class="result-message">{resultMessage}</p>
					{/if}
				</div>
			</section>
		</div>
	{/if}
</main>

<style>
	main {
		width: 760px;
		min-height: 560px;
		padding: 20px;
		background: #f6f7fb;
		color: #202537;
		font-family:
			Inter, "Yu Gothic UI", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif;
	}

	button,
	input {
		font: inherit;
	}

	.topbar {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 14px;
	}

	.eyebrow {
		margin: 0 0 4px;
		color: #687083;
		font-size: 12px;
		font-weight: 700;
	}

	h1,
	h2,
	p {
		margin: 0;
	}

	h1 {
		font-size: 22px;
		line-height: 1.3;
		letter-spacing: 0;
	}

	h2 {
		font-size: 14px;
	}

	.mode,
	.panel-header span {
		border-radius: 999px;
		background: #edf1ff;
		padding: 6px 10px;
		color: #4952c8;
		font-size: 12px;
		font-weight: 800;
		white-space: nowrap;
	}

	.mode[data-mode="mock"] {
		background: #fff4d8;
		color: #9a6700;
	}

	.mode[data-mode="native"] {
		background: #e2f8ef;
		color: #087457;
	}

	.course-summary {
		display: grid;
		grid-template-columns: 1.2fr 1fr auto;
		gap: 8px;
		margin-bottom: 12px;
	}

	.course-summary div {
		display: grid;
		gap: 3px;
		border: 1px solid #dfe4f0;
		border-radius: 8px;
		background: #fff;
		padding: 10px 12px;
	}

	.course-summary span,
	.file-main small,
	.manual-box span {
		color: #687083;
		font-size: 11px;
		font-weight: 800;
	}

	.course-summary strong {
		font-size: 13px;
	}

	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 360px;
		gap: 12px;
	}

	.panel,
	.empty {
		border: 1px solid #dfe4f0;
		border-radius: 8px;
		background: #fff;
		overflow: hidden;
	}

	.empty {
		display: grid;
		gap: 12px;
		place-items: center;
		min-height: 240px;
		padding: 24px;
		color: #687083;
		text-align: center;
	}

	.empty.error {
		color: #9f1d1d;
	}

	.empty button,
	.action-panel button {
		min-height: 40px;
		border: 0;
		border-radius: 8px;
		background: #5b5ff0;
		color: #fff;
		font-weight: 900;
		cursor: pointer;
	}

	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		border-bottom: 1px solid #dfe4f0;
		padding: 12px 14px;
	}

	.file-list,
	.suggestion-list {
		display: grid;
		gap: 8px;
		padding: 12px 14px;
	}

	.file-row,
	.suggestion-option {
		display: grid;
		grid-template-columns: auto auto minmax(0, 1fr);
		gap: 10px;
		align-items: center;
		border: 1px solid #dfe4f0;
		border-radius: 8px;
		padding: 10px;
	}

	.suggestion-option {
		grid-template-columns: auto minmax(0, 1fr);
		align-items: start;
		cursor: pointer;
	}

	.suggestion-option.selected {
		border-color: #5b5ff0;
		background: #fbfbff;
		box-shadow: 0 8px 18px rgba(91, 95, 240, 0.12);
	}

	input[type="checkbox"],
	input[type="radio"] {
		accent-color: #5b5ff0;
	}

	.file-type {
		display: grid;
		width: 42px;
		height: 28px;
		place-items: center;
		border-radius: 7px;
		background: #2f3654;
		color: #fff;
		font-size: 10px;
		font-weight: 900;
	}

	.file-main {
		display: grid;
		gap: 3px;
		min-width: 0;
	}

	.file-main strong,
	.suggestion-option strong {
		overflow-wrap: anywhere;
		font-size: 13px;
		line-height: 1.45;
	}

	.confidence {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 8px;
		align-items: center;
		margin-top: 8px;
	}

	.confidence-bar {
		height: 8px;
		border-radius: 999px;
		background: #edf0f7;
		overflow: hidden;
	}

	.confidence-fill {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: #5b5ff0;
	}

	.manual-box,
	.action-panel {
		display: grid;
		gap: 8px;
		border-top: 1px solid #dfe4f0;
		padding: 12px 14px;
	}

	.manual-box input {
		width: 100%;
		min-height: 40px;
		box-sizing: border-box;
		border: 1px solid #dfe4f0;
		border-radius: 8px;
		padding: 0 10px;
		color: #202537;
	}

	.save-summary,
	.result-message {
		border-radius: 8px;
		background: #edf1ff;
		padding: 10px;
		color: #34398e;
		font-size: 12px;
		font-weight: 800;
		line-height: 1.5;
	}

	.result-message {
		background: #e2f8ef;
		color: #087457;
	}

	.action-panel button:disabled {
		background: #c6cad8;
		cursor: not-allowed;
	}
</style>
