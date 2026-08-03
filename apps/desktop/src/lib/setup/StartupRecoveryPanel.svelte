<script lang="ts">
	import { listen, type UnlistenFn } from "@tauri-apps/api/event";
	import type { LibraryMaintenanceProgress } from "@fuzzy/shared";
	import {
		deriveApplicationState,
		presentApplicationRecoveryDetails,
		userFacingOperationError,
	} from "./application-state";
	import { presentMaintenanceProgress } from "./maintenance-progress";
	import {
		changeLibraryRootClient,
		createFreshDatabaseClient,
		getApplicationRecoveryStatusClient,
		importBackupClient,
		rebuildLibraryClient,
		type ApplicationRecoveryStatus,
		type LibraryMaintenanceSummary,
	} from "./library-maintenance";

	export let initialStatus: ApplicationRecoveryStatus;
	export let onRecovered: (message: string) => void = () => undefined;

	let status = initialStatus;
	let busyAction: "restore" | "fresh" | "rebuild" | "change-root" | null = null;
	let errorMessage: string | null = null;
	let successMessage: string | null = null;
	let recoveryCopyPath: string | null = null;
	let progress: LibraryMaintenanceProgress | null = null;

	function completeProgress(summary: LibraryMaintenanceSummary): void {
		progress = {
			phase: "completed",
			state:
				summary.warnings.length > 0 ? "completedWithWarnings" : "completed",
			completedCount: summary.scannedFileCount,
			totalCount: summary.scannedFileCount,
			warningCount: summary.warnings.length,
		};
	}

	function failProgress(): void {
		if (progress?.phase === "completed" && progress.state === "failed") return;
		progress = {
			phase: "completed",
			state: "failed",
			completedCount: progress?.completedCount ?? 0,
			totalCount: progress?.totalCount ?? null,
			warningCount: progress?.warningCount ?? 0,
		};
	}

	function warnProgress(): void {
		progress = {
			phase: "completed",
			state: "completedWithWarnings",
			completedCount: progress?.completedCount ?? 0,
			totalCount: progress?.totalCount ?? 0,
			warningCount: Math.max(1, progress?.warningCount ?? 0),
		};
	}

	async function refreshStatus(message: string): Promise<void> {
		status = await getApplicationRecoveryStatusClient();
		if (
			status.database.state === "ready" &&
			status.searchIndex.state === "ready"
		) {
			onRecovered(message);
		}
	}

	async function runAction(
		action: typeof busyAction,
		task: () => Promise<void>,
	): Promise<void> {
		if (busyAction) return;
		busyAction = action;
		errorMessage = null;
		successMessage = null;
		progress = null;
		let unlisten: UnlistenFn | null = null;
		try {
			unlisten = await listen<LibraryMaintenanceProgress>(
				"library-maintenance-progress",
				({ payload }) => {
					progress = payload;
				},
			);
			await task();
		} finally {
			unlisten?.();
			busyAction = null;
		}
	}

	async function restoreBackup(): Promise<void> {
		await runAction("restore", async () => {
			try {
				const result = await importBackupClient();
				if (result.cancelled) return;
				recoveryCopyPath = result.recoveryCopyPath ?? null;
				if (result.maintenance) {
					completeProgress(result.maintenance);
				} else if (result.maintenanceError) {
					warnProgress();
				}
				successMessage =
					"バックアップを復元しました。保存済みの授業資料は変更していません。";
				if (result.maintenanceError) {
					errorMessage =
						"復元は完了しましたが、資料情報の準備を完了できませんでした。もう一度お試しください。";
				}
				await refreshStatus(
					"バックアップから復元し、Fuzzyを利用できる状態に戻しました。",
				);
			} catch (error) {
				failProgress();
				errorMessage = userFacingOperationError(
					error,
					"バックアップから復元できませんでした。Fuzzyが作成したバックアップを選び、もう一度お試しください。",
				);
			}
		});
	}

	async function createFreshDatabase(): Promise<void> {
		await runAction("fresh", async () => {
			try {
				const result = await createFreshDatabaseClient();
				if (result.cancelled) return;
				recoveryCopyPath = result.recoveryCopyPath ?? null;
				successMessage =
					"開けなかった設定を保全し、新しく開始する準備ができました。授業資料は変更していません。";
				if (result.indexError) {
					errorMessage =
						"新しい設定は作成できましたが、資料情報の準備を完了できませんでした。";
				}
				await refreshStatus(
					"新しく開始する準備ができました。保存先とフォルダーの作り方を設定してください。",
				);
			} catch (error) {
				failProgress();
				errorMessage = userFacingOperationError(
					error,
					"新しく開始する準備ができませんでした。Fuzzyを終了せず、時間をおいてもう一度お試しください。",
				);
			}
		});
	}

	async function rebuildInformation(): Promise<void> {
		await runAction("rebuild", async () => {
			try {
				const summary = await rebuildLibraryClient();
				completeProgress(summary);
				successMessage =
					"資料の検索・整理情報を作り直しました。授業資料は変更していません。";
				await refreshStatus("資料情報の準備が完了し、Fuzzyを利用できます。");
			} catch (error) {
				failProgress();
				errorMessage = userFacingOperationError(
					error,
					"資料情報を作り直せませんでした。資料の保存が終わってからブラウザを閉じ、もう一度お試しください。",
				);
			}
		});
	}

	async function changeLibraryRoot(): Promise<void> {
		await runAction("change-root", async () => {
			try {
				const result = await changeLibraryRootClient();
				if (result.cancelled) return;
				if (result.maintenance) {
					completeProgress(result.maintenance);
				} else if (result.maintenanceError) {
					warnProgress();
				}
				successMessage = `保存先を変更し、登録済み資料${result.rebasedFileCount}件を確認しました。資料は移動・削除していません。`;
				if (result.maintenanceError) {
					errorMessage =
						"保存先は変更できましたが、資料情報の準備を完了できませんでした。";
				}
				await refreshStatus("保存先の変更と資料情報の準備が完了しました。");
			} catch (error) {
				failProgress();
				errorMessage = userFacingOperationError(
					error,
					"保存先を変更できませんでした。資料があるフォルダーを確認し、もう一度お試しください。",
				);
			}
		});
	}

	$: primaryState = deriveApplicationState(status, true);
	$: needsDataReset = status.dataResetRequired;
	$: needsSettingsRecovery = status.database.state !== "ready";
	$: needsInformationRebuild =
		!needsSettingsRecovery && status.searchIndex.state !== "ready";
	$: progressPresentation = presentMaintenanceProgress(progress);
	$: recoveryDetails = presentApplicationRecoveryDetails(status);
</script>

<section class="recovery-panel" aria-labelledby="startup-recovery-heading">
	<header>
		<p class="chip">Fuzzyの起動準備</p>
		<h1 id="startup-recovery-heading">{primaryState.title}</h1>
		<p class="intro">{primaryState.impact}</p>
	</header>

	<div class="primary-state" aria-live="polite" aria-busy={busyAction !== null}>
		{#if busyAction || progress}
			<h2>{progressPresentation.title}</h2>
			<p>{progressPresentation.countLabel}</p>
			<div
				class:indeterminate={progressPresentation.percent === null &&
					(progress === null || progress.state === "running")}
				class="progress-track"
				role="progressbar"
				aria-label="資料情報の準備"
				aria-valuemin="0"
				aria-valuemax="100"
				aria-valuenow={progressPresentation.percent ?? undefined}
				aria-valuetext={progressPresentation.ariaValueText}
			>
				<span
					style:width={progressPresentation.percent === null
						? "35%"
						: `${progressPresentation.percent}%`}
				></span>
			</div>
			{#if progress?.phase !== "completed"}
				<p>{progressPresentation.availabilityLabel}</p>
			{/if}
		{:else}
			<h2>{primaryState.title}</h2>
			<p>{primaryState.impact}</p>
		{/if}
	</div>

	{#if errorMessage}<p class="error-banner" role="alert">{errorMessage}</p>{/if}
	{#if successMessage}<p class="success-banner" role="status">
			{successMessage}
		</p>{/if}

	{#if needsDataReset}
		<section class="action-card caution">
			<h2>設定データを初期化してください</h2>
			<p>
				このFuzzyでは以前の設定データをそのまま利用できないため、内部の設定・履歴・検索情報を新しく作り直します。
				保存済みの授業資料は変更しません。
			</p>
			<button
				class="primary-button"
				type="button"
				on:click={createFreshDatabase}
				disabled={busyAction !== null}
			>
				{busyAction === "fresh" ? "初期化中…" : "初期状態に戻す"}
			</button>
		</section>
	{:else if needsSettingsRecovery}
		<section class="action-card">
			<h2>バックアップがある場合</h2>
			<p>Fuzzyが作成したバックアップを選ぶと、設定と履歴を復元できます。</p>
			<button
				class="primary-button"
				type="button"
				on:click={restoreBackup}
				disabled={busyAction !== null}
			>
				{busyAction === "restore" ? "復元中…" : "バックアップから復元"}
			</button>
		</section>
		<section class="action-card caution">
			<h2>バックアップがない場合</h2>
			<p>
				開けなかった設定を別の場所へ保全してから、新しい設定で開始します。設定と履歴は初期状態になります。
			</p>
			<button
				class="secondary-button"
				type="button"
				on:click={createFreshDatabase}
				disabled={busyAction !== null}
			>
				{busyAction === "fresh" ? "保全・準備中…" : "設定を保全して新しく開始"}
			</button>
		</section>
	{:else if needsInformationRebuild}
		<section class="action-card">
			<h2>資料があるフォルダーを変更した場合</h2>
			<p>
				このPCで授業資料を置いているフォルダーへ保存先の設定だけを変更できます。
			</p>
			<button
				class="secondary-button"
				type="button"
				on:click={changeLibraryRoot}
				disabled={busyAction !== null}
			>
				{busyAction === "change-root" ? "変更中…" : "保存先を変更"}
			</button>
		</section>
		<section class="action-card">
			<h2>検索・整理情報を作り直す</h2>
			<p>保存済みの授業資料と設定から、Fuzzyが利用する情報を作り直します。</p>
			<button
				class="primary-button"
				type="button"
				on:click={rebuildInformation}
				disabled={busyAction !== null}
			>
				{busyAction === "rebuild" ? "準備中…" : "資料情報を作り直す"}
			</button>
		</section>
	{/if}

	<p class="safety-note">
		この操作では授業資料や設定を外部へ送信しません。保存済みの授業資料は移動・削除されません。
	</p>

	<details>
		<summary>状態の内訳を表示</summary>
		<p>{recoveryDetails.settings}</p>
		<p>{recoveryDetails.information}</p>
		{#if recoveryCopyPath}<p>復旧用の保全コピーを作成しました。</p>{/if}
	</details>
</section>

<style>
	.recovery-panel {
		width: min(100%, 880px);
		margin: 22px auto;
		padding: 28px;
		box-sizing: border-box;
		border-radius: 12px;
		background: var(--fuzzy-color-surface-glass);
		box-shadow: var(--fuzzy-shadow-dialog);
	}
	h1,
	h2,
	p {
		margin-top: 0;
	}
	h1 {
		margin-bottom: 8px;
		font-size: 1.8rem;
	}
	h2 {
		margin-bottom: 7px;
		font-size: 1rem;
	}
	.chip {
		width: fit-content;
		margin-bottom: 12px;
		padding: 4px 10px;
		border-radius: 999px;
		background: var(--fuzzy-color-warning-soft);
		color: var(--fuzzy-color-warning);
		font-size: 0.7rem;
		font-weight: 700;
	}
	.intro,
	.action-card p,
	.safety-note,
	details {
		color: var(--fuzzy-color-text-muted);
		font-size: 0.8rem;
		line-height: 1.7;
	}
	.primary-state,
	.action-card {
		margin-top: 14px;
		padding: 18px;
		border: 1px solid var(--fuzzy-color-border);
		border-radius: 10px;
		background: var(--fuzzy-color-surface-muted);
	}
	.action-card.caution {
		background: var(--fuzzy-color-warning-soft);
		border-color: var(--fuzzy-color-warning-border);
	}
	.error-banner,
	.success-banner {
		margin: 14px 0 0;
		padding: 13px 15px;
		border-radius: 8px;
		font-size: 0.8rem;
	}
	.error-banner {
		background: var(--fuzzy-color-danger-soft);
		color: var(--fuzzy-color-danger);
	}
	.success-banner {
		background: var(--fuzzy-color-success-soft);
		color: var(--fuzzy-color-success-strong);
	}
	.progress-track {
		height: 10px;
		overflow: hidden;
		border-radius: 999px;
		background: var(--fuzzy-color-border);
	}
	.progress-track span {
		display: block;
		height: 100%;
		background: var(--fuzzy-color-primary);
		transition: width 0.2s ease;
	}
	.progress-track.indeterminate span {
		animation: progress 1.2s ease-in-out infinite alternate;
	}
	button {
		border: 0;
		border-radius: 8px;
		padding: 11px 14px;
		font: inherit;
		font-size: 0.78rem;
		font-weight: 700;
		cursor: pointer;
	}
	button:disabled {
		cursor: default;
		opacity: 0.62;
	}
	button:focus-visible,
	summary:focus-visible {
		outline: 3px solid var(--fuzzy-focus-ring);
		outline-offset: 2px;
	}
	.primary-button {
		background: var(--fuzzy-color-primary);
		color: var(--fuzzy-color-text-inverse);
	}
	.secondary-button {
		background: var(--fuzzy-color-surface);
		border: 1px solid var(--fuzzy-color-warning-border);
		color: var(--fuzzy-color-warning);
	}
	.safety-note {
		margin: 18px 0 0;
		padding-top: 16px;
		border-top: 1px solid var(--fuzzy-color-border);
	}
	details {
		margin-top: 14px;
	}
	summary {
		cursor: pointer;
		font-weight: 700;
	}
	@keyframes progress {
		from {
			transform: translateX(-35%);
		}
		to {
			transform: translateX(185%);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.progress-track.indeterminate span {
			animation: none;
		}
		.progress-track span {
			transition: none;
		}
	}
	@media (max-width: 720px) {
		.recovery-panel {
			padding: 20px 16px;
		}
		button {
			width: 100%;
		}
	}
</style>
