<script lang="ts">
	import { onMount } from "svelte";
	import {
		RULE_PRESETS,
		createRulePreviewValues,
		previewRulePattern,
	} from "@fuzzy/shared";
	import {
		getSetupStatusClient,
		pickBaseFolderClient,
		saveInitialSetupClient,
		scanExistingStructureClient,
	} from "$lib/setup/api";
	import { createCourseOverrides } from "$lib/setup/course-overrides";
	import ExtensionInstallStep from "$lib/setup/ExtensionInstallStep.svelte";
	import type {
		InitialRuleOption,
		SetupDraft,
		SetupStatus,
	} from "$lib/setup/types";

	type SetupStepState = "done" | "current" | "pending";

	const stepLabels = ["保存先", "推定結果", "初期ルール", "拡張機能"] as const;
	const sidebarItems = [
		"保存先フォルダ",
		"保存パターン推定",
		"初期ルール選択",
		"ブラウザ拡張機能",
	];

	const rulePreviewExamples = [
		{ course: "情報アーキテクチャ", assignment: "第03回レポート" },
		{ course: "データベース", assignment: "正規化レポート" },
	] as const;
	const basePreviewValues = createRulePreviewValues();
	const ruleOptions: InitialRuleOption[] = RULE_PRESETS.map((rule) => ({
		...rule,
		preview: rulePreviewExamples.map(({ course, assignment }) =>
			previewRulePattern(rule.template, {
				...basePreviewValues,
				course,
				assignment,
			}),
		),
	}));

	let draft: SetupDraft = {
		baseFolderPath: null,
		selectedCandidateId: null,
		selectedRuleId: "year-course-assignment",
		candidates: [],
		courseOverrides: [],
		lastScannedAt: null,
	};

	let setupStatus: SetupStatus = { done: false };
	let currentStepIndex = 2;
	let isPickingFolder = false;
	let isScanning = false;
	let isSaving = false;
	let errorMessage: string | null = null;
	let successMessage: string | null = null;
	const minimumScanLoadingMs = 450;

	onMount(async () => {
		setupStatus = await getSetupStatusClient();

		if (setupStatus.done) {
			currentStepIndex = 3;
		}
	});

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

	function waitForMinimumLoadingTime(startedAt: number): Promise<void> {
		const elapsedMs = Date.now() - startedAt;
		const remainingMs = Math.max(0, minimumScanLoadingMs - elapsedMs);

		return new Promise((resolve) => {
			setTimeout(resolve, remainingMs);
		});
	}

	function selectCandidate(candidateId: string): void {
		const candidate =
			draft.candidates.find(({ id }) => id === candidateId) ?? null;

		draft = {
			...draft,
			selectedCandidateId: candidateId,
			courseOverrides: createCourseOverrides(candidate, draft.courseOverrides),
		};
	}

	function selectRule(ruleId: string): void {
		draft = {
			...draft,
			selectedRuleId: ruleId,
		};
	}

	function toggleOverride(overrideId: string): void {
		draft = {
			...draft,
			courseOverrides: draft.courseOverrides.map((override) =>
				override.id === overrideId
					? { ...override, enabled: !override.enabled }
					: override,
			),
		};
	}

	async function runScan(path: string): Promise<void> {
		const startedAt = Date.now();

		isScanning = true;
		errorMessage = null;
		successMessage = null;

		try {
			const candidates = await scanExistingStructureClient(path);
			const selectedCandidate =
				candidates.find((candidate) => candidate.recommended) ??
				candidates[0] ??
				null;

			draft = {
				...draft,
				baseFolderPath: path,
				candidates,
				courseOverrides: createCourseOverrides(selectedCandidate),
				selectedCandidateId: selectedCandidate?.id ?? null,
				lastScannedAt: new Date().toISOString(),
			};
		} catch {
			errorMessage = "スキャン結果の読み込みに失敗しました。";
		} finally {
			await waitForMinimumLoadingTime(startedAt);
			isScanning = false;
		}
	}

	async function handlePickFolder(): Promise<void> {
		isPickingFolder = true;
		errorMessage = null;
		successMessage = null;

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

	async function handleSaveInitialSetup(): Promise<void> {
		if (!draft.baseFolderPath || !selectedCandidate || !selectedRule) {
			return;
		}

		isSaving = true;
		errorMessage = null;
		successMessage = null;

		try {
			await saveInitialSetupClient({
				path: draft.baseFolderPath,
				pattern: selectedCandidate,
				rule: selectedRule,
				courseOverrides: draft.courseOverrides.filter(
					(override) => override.enabled,
				),
			});

			setupStatus = await getSetupStatusClient();
			successMessage = "保存先と初期ルールを保存しました。";
			currentStepIndex = 3;
		} catch {
			errorMessage = "初期セットアップの保存に失敗しました。";
		} finally {
			isSaving = false;
		}
	}

	$: selectedCandidate =
		draft.candidates.find(
			(candidate) => candidate.id === draft.selectedCandidateId,
		) ?? null;
	$: selectedRule =
		ruleOptions.find((rule) => rule.id === draft.selectedRuleId) ?? null;
	$: selectedCandidateRank =
		selectedCandidate === null
			? null
			: draft.candidates.findIndex(
					(candidate) => candidate.id === draft.selectedCandidateId,
				) + 1;
	$: canSaveSetup = Boolean(
		draft.baseFolderPath && selectedCandidate && selectedRule,
	);
	$: steps = stepLabels.map((label, index) => ({
		label,
		state: (index < currentStepIndex
			? "done"
			: index === currentStepIndex
				? "current"
				: "pending") as SetupStepState,
	}));
</script>

<svelte:head>
	<meta
		name="description"
		content="Fuzzy の初期セットアップ画面。保存パターン、初期ルール、ブラウザ拡張機能の導入を設定できます。"
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
				保存先と初期ルールを設定した後、ブラウザ拡張機能の導入を案内します。
			</p>
			<nav aria-label="セットアップの流れ">
				<ul class="side-list">
					{#each sidebarItems as item, index}
						<li
							class:active={index <= currentStepIndex}
							aria-current={index === currentStepIndex ? "step" : undefined}
						>
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
					<div
						class="progress-item"
						aria-current={item.state === "current" ? "step" : undefined}
					>
						<div
							class:current={item.state === "current"}
							class:done={item.state === "done"}
							class="progress-dot"
						>
							{#if item.state === "done"}
								✓
							{:else}
								{index + 1}
							{/if}
						</div>
						<span>{item.label}</span>
					</div>
				{/each}
			</div>

			<section class="panel" hidden={currentStepIndex !== 2}>
				<div class="panel-header">
					<div>
						<p class="chip">STEP 3 / 4</p>
						<h1>保存パターンを確認して、初期ルールを選ぶ</h1>
						<p class="intro">
							スキャン結果に近い保存パターンを確認し、Fuzzy
							が今後使うフォルダ作成ルールを選びます。
						</p>
					</div>
					<button
						class="primary-button"
						type="button"
						on:click={handlePickFolder}
						disabled={isPickingFolder || isScanning || isSaving}
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
							class:loading={isScanning}
							class="ghost-button"
							type="button"
							on:click={handleRescan}
							disabled={!draft.baseFolderPath || isScanning || isSaving}
							aria-busy={isScanning}
						>
							<span class="ghost-button-label">
								{#if isScanning}
									<span class="spinner" aria-hidden="true"></span>
								{/if}
								<span>
									{#if isScanning}
										再スキャン中...
									{:else}
										再スキャン
									{/if}
								</span>
							</span>
						</button>
					</div>
				</div>

				{#if setupStatus.done}
					<p class="success-banner" role="status">
						保存先と初期ルールは保存済みです。
						{#if setupStatus.savedAt}
							<span>保存日時: {formatScannedAt(setupStatus.savedAt)}</span>
						{/if}
					</p>
				{/if}

				{#if errorMessage}
					<p class="error-banner" role="alert">{errorMessage}</p>
				{/if}

				{#if successMessage}
					<p class="success-banner" role="status">{successMessage}</p>
				{/if}

				<section class="scan-section">
					<div class="scan-heading">
						<div>
							<p class="section-label">保存パターン推定</p>
							<h2>推定結果</h2>
						</div>
						<span class="scan-count">{draft.candidates.length} 件</span>
					</div>

					{#if draft.candidates.length === 0}
						<div class="empty-state">
							<p>フォルダを選ぶと、保存パターンの候補が表示されます。</p>
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

				<section class="rule-section">
					<div class="scan-heading">
						<div>
							<p class="section-label">初期ルール</p>
							<h2>フォルダ作成ルール</h2>
						</div>
					</div>

					<div class="rule-grid">
						{#each ruleOptions as rule}
							<button
								class:selected={rule.id === draft.selectedRuleId}
								class="rule-card"
								type="button"
								on:click={() => selectRule(rule.id)}
							>
								<div class="pattern-title-row">
									<h3>{rule.name}</h3>
									{#if rule.recommended}
										<span class="badge">標準</span>
									{/if}
								</div>
								<p>{rule.description}</p>
								<code>{rule.template}</code>
								<ul>
									{#each rule.preview as preview}
										<li>{preview}</li>
									{/each}
								</ul>
							</button>
						{/each}
					</div>
				</section>

				{#if draft.courseOverrides.length > 0}
					<section class="override-section">
						<div class="override-explanation">
							<p class="section-label">初期例外</p>
							<h2>コース別に外す候補</h2>
							<p class="override-help">
								チェックしたコースは、選択中の初期ルールから外して保存します。たとえば
								`年度 / 科目 / 課題` を選んでいても、そのコースだけは `科目 /
								課題` のように短い並びで扱う想定です。
							</p>
						</div>
						<div>
							<p class="section-label">初期例外</p>
							<h2>コース別に外す候補</h2>
						</div>
						<div class="override-list">
							{#each draft.courseOverrides as override}
								<label class="override-row">
									<input
										type="checkbox"
										checked={override.enabled}
										on:change={() => toggleOverride(override.id)}
									/>
									<span>
										<strong>{override.courseName}</strong>
										<small
											>このコースだけ共通ルールから外し、科目フォルダ直下で保存します。</small
										>
									</span>
								</label>
							{/each}
						</div>
					</section>
				{/if}

				<section class="selection-summary">
					<div>
						<p class="section-label">保存内容</p>
						<h2>現在の選択内容</h2>
					</div>
					<div class="summary-card">
						<p><strong>保存先:</strong> {draft.baseFolderPath ?? "未選択"}</p>
						<p>
							<strong>推定候補:</strong>
							{selectedCandidate?.name ?? "未選択"}
						</p>
						{#if selectedCandidate}
							<p>
								<strong>候補順位:</strong>
								{selectedCandidateRank} / {draft.candidates.length}
							</p>
							<p><strong>一致度:</strong> {selectedCandidate.matchScore}%</p>
						{/if}
						<p><strong>初期ルール:</strong> {selectedRule?.name ?? "未選択"}</p>
						{#if selectedRule}
							<p><strong>テンプレート:</strong> {selectedRule.template}</p>
						{/if}
						<p>
							<strong>初期例外:</strong>
							{draft.courseOverrides.filter((override) => override.enabled)
								.length}件
						</p>
					</div>
				</section>

				<div class="action-row">
					{#if setupStatus.done}
						<button
							class="ghost-button"
							type="button"
							on:click={() => (currentStepIndex = 3)}
						>
							拡張機能の導入へ進む
						</button>
					{/if}
					<button
						class="primary-button"
						type="button"
						on:click={handleSaveInitialSetup}
						disabled={!canSaveSetup || isSaving || isScanning}
					>
						{#if isSaving}
							保存中...
						{:else}
							この内容で初期設定を保存
						{/if}
					</button>
				</div>
			</section>
			{#if currentStepIndex === 3}
				<ExtensionInstallStep onBack={() => (currentStepIndex = 2)} />
			{/if}
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

	.brand,
	.brand-copy,
	.window-actions,
	.progress,
	.progress-item,
	.panel-header,
	.folder-card,
	.scan-heading,
	.selection-summary,
	.action-row {
		display: flex;
	}

	.brand {
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
		border-radius: 8px;
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
		justify-content: flex-end;
		gap: 18px;
		font-size: 0.74rem;
		color: #7f84a0;
	}

	.progress-item {
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

	.progress-dot.done,
	.progress-dot.current {
		background: var(--fuzzy-color-primary);
		color: #fff;
	}

	.progress-dot.current {
		box-shadow: 0 0 0 4px rgba(109, 92, 246, 0.14);
	}

	.panel {
		width: min(100%, 980px);
		margin: 22px auto 0;
		padding: 26px 28px 24px;
		border-radius: 12px;
		background: rgba(255, 255, 255, 0.94);
		box-shadow: 0 28px 52px rgba(96, 105, 151, 0.16);
	}

	.panel-header,
	.folder-card,
	.scan-heading,
	.selection-summary {
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
		color: var(--fuzzy-color-primary);
		font-size: 0.7rem;
		font-weight: 700;
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
		letter-spacing: 0;
	}

	h2 {
		font-size: 1.05rem;
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
		color: #7d83a2;
		text-transform: uppercase;
	}

	.folder-card,
	.summary-card,
	.empty-state,
	.error-banner,
	.success-banner {
		border-radius: 8px;
	}

	.folder-card {
		margin-top: 20px;
		padding: 18px 20px;
		align-items: center;
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

	.scan-section,
	.rule-section,
	.override-section {
		margin-top: 24px;
	}

	.scan-heading h2,
	.selection-summary h2,
	.override-section h2 {
		margin-bottom: 0;
	}

	.scan-count {
		padding: 6px 10px;
		border-radius: 999px;
		background: rgba(124, 104, 246, 0.08);
		color: #6c5cf2;
		font-size: 0.74rem;
		font-weight: 700;
	}

	.pattern-list,
	.rule-grid,
	.override-list {
		margin-top: 14px;
		display: grid;
		gap: 14px;
	}

	.rule-grid {
		grid-template-columns: repeat(3, minmax(0, 1fr));
	}

	.pattern-card,
	.rule-card {
		width: 100%;
		padding: 18px;
		text-align: left;
		border-radius: 8px;
		border: 1px solid rgba(203, 207, 226, 0.76);
		background: #fff;
		cursor: pointer;
		transition:
			border-color 0.18s ease,
			box-shadow 0.18s ease,
			transform 0.18s ease;
	}

	.pattern-card {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 260px;
		gap: 18px;
	}

	.pattern-card.selected,
	.rule-card.selected {
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

	.pattern-main p,
	.rule-card p {
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

	.score-box,
	.example-box {
		padding: 12px 14px;
		border-radius: 8px;
	}

	.score-box {
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
		color: #9c6c00;
		font-size: 0.67rem;
		font-weight: 700;
	}

	.example-box {
		background: var(--fuzzy-color-background);
		color: #666d8f;
		font-size: 0.72rem;
	}

	.example-box p {
		margin-bottom: 8px;
		font-weight: 700;
		color: #555d82;
	}

	.example-box ul,
	.rule-card ul {
		margin: 0;
		padding-left: 1rem;
		line-height: 1.6;
	}

	.rule-card code {
		display: block;
		margin: 12px 0;
		padding: 8px 10px;
		border-radius: 6px;
		background: var(--fuzzy-color-background);
		color: #3f4566;
		font-size: 0.75rem;
		white-space: normal;
	}

	.rule-card ul {
		color: #666d8f;
		font-size: 0.72rem;
	}

	.override-row {
		padding: 12px 14px;
		display: flex;
		align-items: flex-start;
		gap: 10px;
		border-radius: 8px;
		background: #f8f9ff;
		border: 1px solid rgba(203, 207, 226, 0.76);
		font-size: 0.8rem;
		color: #43576a;
	}

	.override-section > div:not(.override-explanation):not(.override-list) {
		display: none;
	}

	.override-row input {
		margin-top: 2px;
	}

	.override-row small {
		display: block;
		margin-top: 3px;
		color: #7b809d;
		line-height: 1.5;
	}

	.override-help {
		max-width: 680px;
		margin: 8px 0 0;
		font-size: 0.78rem;
		line-height: 1.7;
		color: #7b809d;
	}

	.selection-summary {
		margin-top: 26px;
	}

	.summary-card {
		margin-top: 14px;
		padding: 16px 18px;
		background: linear-gradient(180deg, #fff8dd 0%, #ffefb5 100%);
		color: #6f5600;
		font-size: 0.8rem;
		line-height: 1.7;
	}

	.summary-card strong {
		color: #5b4600;
	}

	.empty-state,
	.error-banner,
	.success-banner {
		margin-top: 14px;
		padding: 14px 16px;
		font-size: 0.8rem;
	}

	.empty-state {
		background: rgba(244, 245, 251, 0.82);
		border: 1px dashed rgba(179, 184, 210, 0.8);
		color: #7d83a2;
		text-align: center;
	}

	.error-banner {
		background: #fff2f0;
		border: 1px solid #f2c5bd;
		color: #ab3e2d;
	}

	.success-banner {
		background: #edf8f1;
		border: 1px solid #b9e2c7;
		color: #2e6b43;
	}

	.success-banner span {
		display: block;
		margin-top: 4px;
	}

	.action-row {
		margin-top: 18px;
		justify-content: flex-end;
		gap: 10px;
	}

	.ghost-button,
	.primary-button {
		border: none;
		border-radius: 8px;
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
		background: rgba(255, 255, 255, 0.78);
		color: #6256ca;
		font-size: 0.74rem;
		font-weight: 700;
	}

	.ghost-button.loading {
		background: rgba(109, 92, 246, 0.1);
	}

	.ghost-button-label {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}

	.spinner {
		width: 12px;
		height: 12px;
		border: 2px solid rgba(98, 86, 202, 0.22);
		border-top-color: #6256ca;
		border-radius: 999px;
		animation: spin 0.8s linear infinite;
	}

	.primary-button {
		padding: 13px 16px;
		background: linear-gradient(180deg, #7f6cff 0%, #6958f5 100%);
		color: #fff;
		font-weight: 700;
		box-shadow: 0 14px 28px rgba(109, 92, 246, 0.28);
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
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

		.rule-grid {
			grid-template-columns: 1fr;
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

		.primary-button,
		.action-row {
			width: 100%;
		}

		.brand-copy {
			flex-direction: column;
			align-items: flex-start;
			gap: 0;
		}
	}
</style>
