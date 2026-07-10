<script lang="ts">
	import {
		pickBaseFolderClient,
		scanExistingStructureClient,
	} from "$lib/setup/api";
	import type { PatternCandidate, SetupDraft } from "$lib/setup/types";

	const steps = [
		{ label: "保存先フォルダ", state: "current" },
		{ label: "既存構成スキャン", state: "current" },
		{ label: "保存", state: "upcoming" },
	] as const;

	const sidebarItems = [
		"保存先フォルダを選ぶ",
		"既存の並び方を確認する",
		"選んだ候補を次の設定に渡す",
	];

	let draft: SetupDraft = {
		baseFolderPath: null,
		selectedCandidateId: null,
		candidates: [],
		lastScannedAt: null,
	};

	let isPickingFolder = false;
	let isScanning = false;
	let errorMessage: string | null = null;

	function formatScannedAt(value: string | null): string {
		if (!value) {
			return "未実行";
		}

		return new Intl.DateTimeFormat("ja-JP", {
			month: "numeric",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		}).format(new Date(value));
	}

	function selectCandidate(candidateId: string): void {
		draft = {
			...draft,
			selectedCandidateId: candidateId,
		};
	}

	async function runScan(path: string): Promise<void> {
		isScanning = true;
		errorMessage = null;

		try {
			const candidates = await scanExistingStructureClient(path);
			const selectedCandidateId =
				candidates.find((candidate) => candidate.recommended)?.id ??
				candidates[0]?.id ??
				null;

			draft = {
				...draft,
				baseFolderPath: path,
				candidates,
				selectedCandidateId,
				lastScannedAt: new Date().toISOString(),
			};
		} catch {
			errorMessage = "スキャン結果の読み込みに失敗しました。";
		} finally {
			isScanning = false;
		}
	}

	async function handlePickFolder(): Promise<void> {
		isPickingFolder = true;
		errorMessage = null;

		try {
			const path = await pickBaseFolderClient();

			if (!path) {
				return;
			}

			await runScan(path);
		} catch {
			errorMessage = "フォルダ選択に失敗しました。";
		} finally {
			isPickingFolder = false;
		}
	}

	async function handleRescan(): Promise<void> {
		if (!draft.baseFolderPath) {
			return;
		}

		await runScan(draft.baseFolderPath);
	}

	$: selectedCandidate =
		draft.candidates.find(
			(candidate) => candidate.id === draft.selectedCandidateId,
		) ?? null;
</script>

<svelte:head>
	<meta
		name="description"
		content="Fuzzy の初期セットアップ画面。保存先フォルダの選択と既存構成スキャン結果を確認できます。"
	/>
</svelte:head>

<main class="window">
	<header class="titlebar">
		<div class="brand">
			<div class="brand-mark">F</div>
			<div class="brand-copy">
				<strong>Fuzzy</strong>
				<span>初期セットアップ</span>
			</div>
		</div>
		<div class="window-actions" aria-hidden="true">
			<span></span>
			<span></span>
			<span></span>
		</div>
	</header>

	<section class="workspace">
		<aside class="sidebar">
			<p class="sidebar-label">
				Issue #46: 保存先の選択と既存構成スキャンを先に固めます。
			</p>
			<nav aria-label="セットアップの流れ">
				<ul class="side-list">
					{#each sidebarItems as item, index}
						<li class:active={index < 2}>
							<span class="side-index">{index + 1}</span>
							<span>{item}</span>
						</li>
					{/each}
				</ul>
			</nav>
		</aside>

		<section class="content">
			<div class="progress" aria-label="進捗">
				{#each steps as item, index}
					<div class="progress-item">
						<div
							class:current={item.state === "current"}
							class:upcoming={item.state === "upcoming"}
							class="progress-dot"
						>
							{index + 1}
						</div>
						<span>{item.label}</span>
					</div>
				{/each}
			</div>

			<section class="panel">
				<div class="panel-header">
					<div>
						<p class="chip">STEP 1-2 / 3</p>
						<h1>保存先フォルダを選んで、既存の並び方を確認する</h1>
						<p class="intro">
							今は UI
							を先に完成させる段階なので、フォルダ選択とスキャン結果はモック値で完結します。
							将来はここを `pick_base_folder` と `scan_existing_structure`
							に差し替える前提です。
						</p>
					</div>
					<button
						class="primary-button"
						type="button"
						on:click={handlePickFolder}
						disabled={isPickingFolder || isScanning}
					>
						{#if isPickingFolder}
							フォルダを選択中...
						{:else}
							保存先フォルダを選ぶ
						{/if}
					</button>
				</div>

				<div class="folder-card">
					<div>
						<p class="section-label">選択中の保存先</p>
						<strong>{draft.baseFolderPath ?? "まだ選択されていません"}</strong>
					</div>
					<div class="folder-meta">
						<span>最終スキャン: {formatScannedAt(draft.lastScannedAt)}</span>
						<button
							class="ghost-button"
							type="button"
							on:click={handleRescan}
							disabled={!draft.baseFolderPath || isScanning}
						>
							{#if isScanning}
								再スキャン中...
							{:else}
								再スキャン
							{/if}
						</button>
					</div>
				</div>

				{#if errorMessage}
					<p class="error-banner" role="alert">{errorMessage}</p>
				{/if}

				<section class="scan-section">
					<div class="scan-heading">
						<div>
							<p class="section-label">既存構成の候補</p>
							<h2>スキャン結果</h2>
						</div>
						<span class="scan-count">{draft.candidates.length} 件</span>
					</div>

					{#if draft.candidates.length === 0}
						<div class="empty-state">
							<p>フォルダを選ぶと、既存構成の候補がここに表示されます。</p>
						</div>
					{:else}
						<div class="pattern-list">
							{#each draft.candidates as candidate}
								<button
									class:selected={candidate.id === draft.selectedCandidateId}
									class="pattern-card"
									type="button"
									on:click={() => selectCandidate(candidate.id)}
								>
									<div class="pattern-main">
										<div class="pattern-title-row">
											<h3>{candidate.name}</h3>
											{#if candidate.recommended}
												<span class="badge">おすすめ</span>
											{/if}
										</div>
										<p>{candidate.description}</p>
										<p class="reason">{candidate.reason}</p>
									</div>

									<div class="pattern-side">
										<div class="score-box">
											<span>一致度</span>
											<strong>{candidate.matchScore}%</strong>
										</div>
										<div
											class="example-box"
											aria-label={`${candidate.name} の例`}
										>
											<p>検出された並び</p>
											<ul>
												{#each candidate.folders as folder}
													<li>{folder}</li>
												{/each}
											</ul>
										</div>
									</div>
								</button>
							{/each}
						</div>
					{/if}
				</section>

				<section class="selection-summary">
					<div>
						<p class="section-label">次の issue #47 へ渡す想定</p>
						<h2>現在の選択内容</h2>
					</div>
					<div class="summary-card">
						<p>保存先: {draft.baseFolderPath ?? "未選択"}</p>
						<p>選択候補: {selectedCandidate?.name ?? "未選択"}</p>
						<p>保存処理は issue #47 で `save_initial_setup` に接続します。</p>
					</div>
				</section>
			</section>
		</section>
	</section>
</main>

<style>
	:global(body) {
		margin: 0;
		font-family: "BIZ UDPGothic", "Yu Gothic UI", "Segoe UI", sans-serif;
		background:
			linear-gradient(180deg, #9d8bff 0 4px, transparent 4px),
			radial-gradient(
				circle at top,
				rgba(134, 118, 239, 0.22),
				transparent 26%
			),
			linear-gradient(180deg, #f6f7fb 0%, #eceef7 100%);
		color: #27283a;
	}

	.window {
		min-height: 100vh;
		padding: 10px 14px 14px;
		box-sizing: border-box;
	}

	.titlebar {
		height: 42px;
		padding: 0 14px 0 18px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		border-radius: 14px 14px 0 0;
		background: rgba(255, 255, 255, 0.92);
		border: 1px solid rgba(130, 140, 190, 0.12);
		border-bottom: none;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.brand-mark {
		width: 18px;
		height: 18px;
		display: grid;
		place-items: center;
		border-radius: 6px;
		background: linear-gradient(180deg, #8d7bff 0%, #6b5bf6 100%);
		color: #fff;
		font-size: 0.72rem;
		font-weight: 700;
		box-shadow: 0 5px 14px rgba(109, 92, 246, 0.35);
	}

	.brand-copy {
		display: flex;
		align-items: baseline;
		gap: 8px;
		font-size: 0.76rem;
		color: #8c90ab;
	}

	.brand-copy strong {
		color: #4a4f74;
		font-size: 0.82rem;
	}

	.window-actions {
		display: flex;
		gap: 8px;
	}

	.window-actions span {
		width: 10px;
		height: 10px;
		border-radius: 999px;
		background: #d7dbeb;
	}

	.workspace {
		min-height: calc(100vh - 56px);
		display: grid;
		grid-template-columns: 248px minmax(0, 1fr);
		border-radius: 0 0 20px 20px;
		overflow: hidden;
		background: rgba(255, 255, 255, 0.64);
		border: 1px solid rgba(130, 140, 190, 0.12);
		box-shadow: 0 26px 54px rgba(104, 112, 167, 0.12);
	}

	.sidebar {
		padding: 26px 18px;
		background: linear-gradient(
			180deg,
			rgba(247, 248, 252, 0.96),
			rgba(240, 241, 247, 0.96)
		);
		border-right: 1px solid rgba(130, 140, 190, 0.12);
	}

	.sidebar-label {
		margin: 0 0 24px;
		font-size: 0.74rem;
		line-height: 1.6;
		color: #8b8fa6;
	}

	.side-list {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: 10px;
	}

	.side-list li {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 12px;
		border-radius: 12px;
		color: #777d98;
		font-size: 0.88rem;
	}

	.side-list li.active {
		background: rgba(124, 104, 246, 0.08);
		color: #5a4be0;
		font-weight: 700;
	}

	.side-index {
		width: 22px;
		height: 22px;
		display: grid;
		place-items: center;
		border-radius: 999px;
		background: rgba(124, 104, 246, 0.1);
		font-size: 0.74rem;
	}

	.content {
		padding: 22px 24px 28px;
		background:
			radial-gradient(
				circle at top,
				rgba(255, 255, 255, 0.88),
				transparent 55%
			),
			linear-gradient(
				180deg,
				rgba(244, 246, 252, 0.95),
				rgba(236, 238, 246, 0.95)
			);
	}

	.progress {
		display: flex;
		justify-content: flex-end;
		gap: 18px;
		font-size: 0.74rem;
		color: #7f84a0;
	}

	.progress-item {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.progress-dot {
		width: 18px;
		height: 18px;
		display: grid;
		place-items: center;
		border-radius: 999px;
		font-size: 0.7rem;
		font-weight: 700;
		background: #d8dced;
		color: #7f84a0;
	}

	.progress-dot.current {
		background: #6d5cf6;
		color: #fff;
		box-shadow: 0 0 0 4px rgba(109, 92, 246, 0.14);
	}

	.progress-dot.upcoming {
		background: #d8dced;
	}

	.panel {
		width: min(100%, 940px);
		margin: 22px auto 0;
		padding: 26px 28px 24px;
		border-radius: 24px;
		background: rgba(255, 255, 255, 0.94);
		box-shadow: 0 28px 52px rgba(96, 105, 151, 0.16);
	}

	.panel-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
	}

	.chip {
		width: fit-content;
		margin: 0 0 12px;
		padding: 4px 10px;
		border-radius: 999px;
		background: rgba(122, 107, 246, 0.1);
		color: #6d5cf6;
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.04em;
	}

	h1,
	h2,
	h3,
	p,
	ul {
		margin-top: 0;
	}

	h1 {
		margin-bottom: 8px;
		font-size: 1.8rem;
		letter-spacing: -0.02em;
	}

	.intro {
		max-width: 640px;
		margin-bottom: 0;
		font-size: 0.82rem;
		line-height: 1.7;
		color: #8085a0;
	}

	.section-label {
		margin-bottom: 6px;
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		color: #7d83a2;
		text-transform: uppercase;
	}

	.folder-card,
	.summary-card,
	.empty-state,
	.error-banner {
		border-radius: 18px;
	}

	.folder-card {
		margin-top: 20px;
		padding: 18px 20px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		background: linear-gradient(180deg, #f8f9ff 0%, #f1f3fc 100%);
		border: 1px solid rgba(203, 207, 226, 0.76);
	}

	.folder-card strong {
		font-size: 0.98rem;
		color: #3f4566;
		word-break: break-all;
	}

	.folder-meta {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 10px;
		font-size: 0.76rem;
		color: #7b809d;
	}

	.scan-section {
		margin-top: 24px;
	}

	.scan-heading,
	.selection-summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
	}

	.scan-heading h2,
	.selection-summary h2 {
		margin-bottom: 0;
		font-size: 1.05rem;
	}

	.scan-count {
		padding: 6px 10px;
		border-radius: 999px;
		background: rgba(124, 104, 246, 0.08);
		color: #6c5cf2;
		font-size: 0.74rem;
		font-weight: 700;
	}

	.pattern-list {
		margin-top: 14px;
		display: grid;
		gap: 14px;
	}

	.pattern-card {
		width: 100%;
		padding: 18px;
		display: grid;
		grid-template-columns: minmax(0, 1fr) 260px;
		gap: 18px;
		text-align: left;
		border-radius: 18px;
		border: 1px solid rgba(203, 207, 226, 0.76);
		background: #fff;
		cursor: pointer;
		transition:
			border-color 0.18s ease,
			box-shadow 0.18s ease,
			transform 0.18s ease;
	}

	.pattern-card.selected {
		border-color: #7c68f6;
		box-shadow: 0 0 0 3px rgba(124, 104, 246, 0.12);
		transform: translateY(-1px);
	}

	.pattern-title-row {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 8px;
	}

	.pattern-title-row h3 {
		margin-bottom: 0;
		font-size: 1rem;
	}

	.pattern-main p {
		margin-bottom: 0;
		font-size: 0.78rem;
		line-height: 1.65;
		color: #747b99;
	}

	.reason {
		margin-top: 10px;
		color: #575f84;
		font-weight: 700;
	}

	.pattern-side {
		display: grid;
		gap: 12px;
	}

	.score-box {
		padding: 12px 14px;
		border-radius: 14px;
		background: linear-gradient(180deg, #f6f0ff 0%, #ece8ff 100%);
		color: #6457d6;
	}

	.score-box span {
		display: block;
		margin-bottom: 4px;
		font-size: 0.72rem;
		font-weight: 700;
	}

	.score-box strong {
		font-size: 1.3rem;
	}

	.badge {
		padding: 3px 8px;
		border-radius: 999px;
		background: #fff4d9;
		color: #bb7a00;
		font-size: 0.67rem;
		font-weight: 700;
	}

	.example-box {
		padding: 12px 14px;
		border-radius: 14px;
		background: #f4f5fb;
		color: #666d8f;
		font-size: 0.72rem;
	}

	.example-box p {
		margin-bottom: 8px;
		font-weight: 700;
		color: #555d82;
	}

	.example-box ul {
		margin: 0;
		padding-left: 1rem;
		line-height: 1.6;
	}

	.selection-summary {
		margin-top: 26px;
		align-items: flex-start;
	}

	.summary-card {
		margin-top: 14px;
		padding: 16px 18px;
		background: linear-gradient(180deg, #fff8dd 0%, #ffefb5 100%);
		color: #6f5600;
		font-size: 0.8rem;
		line-height: 1.7;
	}

	.empty-state {
		margin-top: 14px;
		padding: 28px 20px;
		background: rgba(244, 245, 251, 0.82);
		border: 1px dashed rgba(179, 184, 210, 0.8);
		color: #7d83a2;
		text-align: center;
	}

	.error-banner {
		margin-top: 14px;
		padding: 12px 14px;
		background: #fff2f0;
		border: 1px solid #f2c5bd;
		color: #ab3e2d;
		font-size: 0.78rem;
	}

	.ghost-button,
	.primary-button {
		border: none;
		font: inherit;
		cursor: pointer;
	}

	.ghost-button:disabled,
	.primary-button:disabled {
		cursor: default;
		opacity: 0.7;
	}

	.ghost-button {
		padding: 8px 10px;
		border-radius: 10px;
		background: rgba(255, 255, 255, 0.72);
		color: #6256ca;
		font-size: 0.74rem;
		font-weight: 700;
	}

	.primary-button {
		padding: 13px 16px;
		border-radius: 14px;
		background: linear-gradient(180deg, #7f6cff 0%, #6958f5 100%);
		color: #fff;
		font-weight: 700;
		box-shadow: 0 14px 28px rgba(109, 92, 246, 0.28);
	}

	@media (max-width: 980px) {
		.workspace {
			grid-template-columns: 1fr;
		}

		.sidebar {
			border-right: none;
			border-bottom: 1px solid rgba(130, 140, 190, 0.12);
		}

		.progress {
			justify-content: flex-start;
			flex-wrap: wrap;
		}

		.panel-header,
		.folder-card,
		.scan-heading,
		.selection-summary {
			flex-direction: column;
			align-items: stretch;
		}
	}

	@media (max-width: 720px) {
		.window {
			padding: 8px;
		}

		.content {
			padding: 16px;
		}

		.panel {
			padding: 20px 16px 18px;
		}

		.pattern-card {
			grid-template-columns: 1fr;
		}

		.folder-meta {
			align-items: flex-start;
		}

		.primary-button {
			width: 100%;
		}

		.brand-copy {
			flex-direction: column;
			align-items: flex-start;
			gap: 0;
		}
	}
</style>
