<script lang="ts">
	import { onMount } from "svelte";
	import { listen, type UnlistenFn } from "@tauri-apps/api/event";
	import type {
		ExtensionRecoveryStatus,
		LibraryMaintenanceProgress,
	} from "@fuzzy/shared";
	import {
		ExtensionInstallError,
		getExtensionInstallDestination,
		getPreferredExtensionInstallChannel,
		isTauriRuntime,
		openExtensionInstallDestinationClient,
		repairNativeHostInstallationClient,
	} from "./extension-install";
	import {
		deriveExtensionRecoveryViewState,
		getExtensionRecoveryStatusClient,
		openMoodleForRecoveryClient,
	} from "./extension-recovery";
	import {
		changeLibraryRootClient,
		exportBackupClient,
		importBackupClient,
		rebuildLibraryClient,
	} from "./library-maintenance";
	import type { LibraryMaintenanceSummary } from "./library-maintenance";
	import { userFacingOperationError } from "./application-state";
	import { presentMaintenanceProgress } from "./maintenance-progress";

	export let initialStatus: ExtensionRecoveryStatus;

	const selectedChannel = getPreferredExtensionInstallChannel();
	const destination = getExtensionInstallDestination(selectedChannel);
	const pollIntervalMs = 1000;

	let status = initialStatus;
	let recheckStartedAt: string | null = null;
	let nowMs = Date.now();
	let isStatusRequestRunning = false;
	let statusRequestFailed = false;
	let isManualRecheck = false;
	let isOpening = false;
	let errorMessage: string | null = null;
	let successMessage: string | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let maintenanceSummary: LibraryMaintenanceSummary | null = null;
	let maintenanceError: string | null = null;
	let maintenanceSuccess: string | null = null;
	let isRebuildingLibrary = false;
	let isChangingLibraryRoot = false;
	let isExportingBackup = false;
	let isImportingBackup = false;
	let isRepairingNativeHost = false;
	let maintenanceProgress: LibraryMaintenanceProgress | null = null;
	let unlistenMaintenance: UnlistenFn | null = null;

	onMount(() => {
		if (isTauriRuntime()) {
			void listen<LibraryMaintenanceProgress>(
				"library-maintenance-progress",
				({ payload }) => {
					maintenanceProgress = payload;
				},
			).then((unlisten) => {
				unlistenMaintenance = unlisten;
			});
		}
		pollTimer = setInterval(() => {
			if (status.state === "ready" && !recheckStartedAt) return;
			nowMs = Date.now();
			void refreshStatus();
		}, pollIntervalMs);

		return () => {
			if (pollTimer) clearInterval(pollTimer);
			unlistenMaintenance?.();
		};
	});

	function formatDate(value: string): string {
		return new Intl.DateTimeFormat("ja-JP", {
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		}).format(new Date(value));
	}

	function isMaintenanceActionRunning(): boolean {
		return (
			isRebuildingLibrary ||
			isChangingLibraryRoot ||
			isExportingBackup ||
			isImportingBackup ||
			isRepairingNativeHost
		);
	}

	function completeMaintenanceProgress(
		summary: LibraryMaintenanceSummary,
	): void {
		maintenanceProgress = {
			phase: "completed",
			state:
				summary.warnings.length > 0 ? "completedWithWarnings" : "completed",
			completedCount: summary.scannedFileCount,
			totalCount: summary.scannedFileCount,
			warningCount: summary.warnings.length,
		};
	}

	function failMaintenanceProgress(): void {
		if (
			maintenanceProgress?.phase === "completed" &&
			maintenanceProgress.state === "failed"
		) {
			return;
		}
		maintenanceProgress = {
			phase: "completed",
			state: "failed",
			completedCount: maintenanceProgress?.completedCount ?? 0,
			totalCount: maintenanceProgress?.totalCount ?? null,
			warningCount: maintenanceProgress?.warningCount ?? 0,
		};
	}

	function warnMaintenanceProgress(): void {
		maintenanceProgress = {
			phase: "completed",
			state: "completedWithWarnings",
			completedCount: maintenanceProgress?.completedCount ?? 0,
			totalCount: maintenanceProgress?.totalCount ?? 0,
			warningCount: Math.max(1, maintenanceProgress?.warningCount ?? 0),
		};
	}

	async function refreshStatus(): Promise<void> {
		if (isStatusRequestRunning) return;
		isStatusRequestRunning = true;
		try {
			const wasReady = status.state === "ready";
			status = await getExtensionRecoveryStatusClient();
			statusRequestFailed = false;
			errorMessage = null;
			if (status.state === "ready") {
				recheckStartedAt = null;
				if (!wasReady) {
					successMessage =
						"拡張機能から新しい応答を確認しました。復旧は完了です。";
				}
			}
		} catch (error) {
			statusRequestFailed = true;
			successMessage = null;
			errorMessage =
				error instanceof Error
					? error.message
					: "拡張機能の応答情報を確認できませんでした。";
		} finally {
			isStatusRequestRunning = false;
		}
	}

	async function startRecheck(openMoodle: boolean): Promise<void> {
		if (isManualRecheck || isOpening) return;
		isManualRecheck = true;
		errorMessage = null;
		successMessage = null;
		try {
			if (openMoodle) {
				await openMoodleForRecoveryClient();
				successMessage =
					"Moodleを既定のブラウザで開きました。拡張機能からの新しい応答を待っています。";
			}
			recheckStartedAt = new Date().toISOString();
			nowMs = Date.now();
			await refreshStatus();
		} catch (error) {
			errorMessage =
				error instanceof ExtensionInstallError
					? error.message
					: "拡張機能の状態を再確認できませんでした。";
			recheckStartedAt = null;
		} finally {
			isManualRecheck = false;
		}
	}

	async function openInstallGuide(): Promise<void> {
		if (isOpening || isManualRecheck) return;
		isOpening = true;
		errorMessage = null;
		successMessage = null;
		try {
			const result =
				await openExtensionInstallDestinationClient(selectedChannel);
			successMessage = result.mocked
				? "このプレビューでは導入先を開きません。Fuzzyのデスクトップアプリで確認してください。"
				: "拡張機能の導入先を開きました。更新または再インストール後の応答を待っています。";
			recheckStartedAt = new Date().toISOString();
			nowMs = Date.now();
		} catch (error) {
			errorMessage =
				error instanceof Error
					? error.message
					: "拡張機能の導入先を開けませんでした。";
		} finally {
			isOpening = false;
		}
	}

	async function rebuildLibrary(): Promise<void> {
		if (isMaintenanceActionRunning()) return;
		isRebuildingLibrary = true;
		maintenanceProgress = null;
		maintenanceError = null;
		maintenanceSuccess = null;
		try {
			maintenanceSummary = await rebuildLibraryClient();
			completeMaintenanceProgress(maintenanceSummary);
			maintenanceSuccess = "保存先の確認と資料情報の作り直しが完了しました。";
		} catch (error) {
			failMaintenanceProgress();
			maintenanceError = userFacingOperationError(
				error,
				"資料情報を作り直せませんでした。資料の保存完了後にブラウザを閉じ、再試行してください。",
			);
		} finally {
			isRebuildingLibrary = false;
		}
	}

	async function changeLibraryRoot(): Promise<void> {
		if (isMaintenanceActionRunning()) return;
		isChangingLibraryRoot = true;
		maintenanceProgress = null;
		maintenanceError = null;
		maintenanceSuccess = null;
		try {
			const result = await changeLibraryRootClient();
			if (result.cancelled) {
				maintenanceSuccess =
					"保存先の変更をキャンセルしました。設定と資料ファイルは変更していません。";
				return;
			}
			maintenanceSummary = result.maintenance ?? null;
			const rebasedMessage =
				result.rebasedFileCount > 0
					? `既存資料${result.rebasedFileCount}件の登録先を新しい保存先へ引き継ぎました。`
					: "新しい保存先を設定しました。";
			if (result.maintenance) {
				completeMaintenanceProgress(result.maintenance);
				maintenanceSuccess = `${rebasedMessage} 既存ルールを保持し、保存先の確認と資料情報の作り直しを完了しました。資料ファイルは移動・削除していません。`;
			} else {
				warnMaintenanceProgress();
				maintenanceSuccess = `${rebasedMessage} 既存ルールと資料ファイルは変更していません。`;
				maintenanceError =
					"保存先の変更は完了しましたが、資料情報を作り直せませんでした。ブラウザを閉じ、「保存先を確認して資料情報を作り直す」を押してください。";
			}
		} catch (error) {
			failMaintenanceProgress();
			maintenanceError = userFacingOperationError(
				error,
				"保存先を変更できませんでした。資料があるフォルダーを確認し、もう一度お試しください。",
			);
		} finally {
			isChangingLibraryRoot = false;
		}
	}

	async function exportBackup(): Promise<void> {
		if (isMaintenanceActionRunning()) return;
		isExportingBackup = true;
		maintenanceError = null;
		maintenanceSuccess = null;
		try {
			const result = await exportBackupClient();
			if (result.cancelled) return;
			maintenanceSuccess = "選択した場所へバックアップを書き出しました。";
		} catch (error) {
			maintenanceError = userFacingOperationError(
				error,
				"バックアップを書き出せませんでした。保存先を変えて、もう一度お試しください。",
			);
		} finally {
			isExportingBackup = false;
		}
	}

	async function importBackup(): Promise<void> {
		if (isMaintenanceActionRunning()) return;
		isImportingBackup = true;
		maintenanceProgress = null;
		maintenanceError = null;
		maintenanceSuccess = null;
		try {
			const result = await importBackupClient();
			if (result.cancelled) return;
			maintenanceSummary = result.maintenance ?? null;
			if (result.maintenance) {
				completeMaintenanceProgress(result.maintenance);
				maintenanceSuccess =
					"バックアップを復元し、保存先の確認と資料情報の作り直しを完了しました。";
			} else {
				warnMaintenanceProgress();
				maintenanceSuccess =
					"バックアップの復元は完了しました。保存済みの資料ファイルは変更していません。";
				maintenanceError =
					"復元後の資料情報を準備できませんでした。保存先を確認し、「保存先を確認して資料情報を作り直す」を押してください。";
			}
		} catch (error) {
			failMaintenanceProgress();
			maintenanceError = userFacingOperationError(
				error,
				"バックアップから復元できませんでした。Fuzzyが作成したバックアップを選び、もう一度お試しください。",
			);
		} finally {
			isImportingBackup = false;
		}
	}

	async function repairNativeHost(): Promise<void> {
		if (isMaintenanceActionRunning()) return;
		isRepairingNativeHost = true;
		maintenanceError = null;
		maintenanceSuccess = null;
		try {
			const result = await repairNativeHostInstallationClient();
			if (result.ready) {
				maintenanceSuccess = "拡張機能との接続を自動修復しました。";
			} else {
				maintenanceError =
					"拡張機能との接続を自動修復できませんでした。Fuzzyを再起動してから再試行してください。";
			}
		} catch (error) {
			maintenanceError = userFacingOperationError(
				error,
				"拡張機能との接続を自動修復できませんでした。Fuzzyを再起動してから再試行してください。",
			);
		} finally {
			isRepairingNativeHost = false;
		}
	}

	$: viewState = deriveExtensionRecoveryViewState(
		status,
		recheckStartedAt,
		nowMs,
	);
	$: observation = status.observation;
	$: maintenanceProgressPresentation =
		presentMaintenanceProgress(maintenanceProgress);
	$: maintenanceActionRunning = isMaintenanceActionRunning();
</script>

<section class="recovery-panel" aria-labelledby="extension-recovery-heading">
	<header class="recovery-header">
		<div>
			<p class="chip">拡張機能の状態</p>
			<h1 id="extension-recovery-heading">Fuzzyの利用状態を確認</h1>
			<p class="intro">
				拡張機能から最後に届いた応答とバージョンを確認します。
			</p>
		</div>
		<span class="local-badge">あなたのPC上で確認</span>
	</header>

	{#if errorMessage && !statusRequestFailed}
		<p class="error-banner" role="alert">{errorMessage}</p>
	{:else if successMessage}
		<p class="success-banner" role="status">{successMessage}</p>
	{/if}

	<section
		class:complete={viewState === "ready"}
		class:warning={viewState === "stale" || viewState === "checking"}
		class:error={statusRequestFailed ||
			viewState === "timed-out" ||
			viewState === "incompatible" ||
			viewState === "missing"}
		class="status-card"
	>
		{#if statusRequestFailed}
			<div class="status-icon error" aria-hidden="true">!</div>
			<div>
				<p class="section-label">確認できません</p>
				<h2>現在の利用状態を確認できませんでした</h2>
				<p>
					通信を確認して「応答を再確認」を押してください。現在の設定と保存済み資料は変更されていません。
				</p>
			</div>
		{:else if viewState === "ready" && observation}
			<div class="status-icon complete" aria-hidden="true">✓</div>
			<div>
				<p class="section-label">正常</p>
				<h2>拡張機能から最近の応答を確認しました</h2>
				<p>
					拡張機能バージョン {observation.extensionVersion}から
					{formatDate(observation.lastSeenAt)} に応答がありました。
				</p>
			</div>
		{:else if viewState === "incompatible" && observation}
			<div class="status-icon error" aria-hidden="true">!</div>
			<div>
				<p class="section-label">更新が必要です</p>
				<h2>現在の拡張機能はこのアプリのバージョンに対応していません</h2>
				<p>
					確認した拡張機能はバージョン {observation.extensionVersion}です。「拡張機能の導入手順を開く」から最新版をインストールし、Moodleを開いて再確認してください。
				</p>
			</div>
		{:else if viewState === "checking"}
			<div class="status-icon checking" aria-hidden="true"></div>
			<div>
				<p class="section-label">再確認中</p>
				<h2>拡張機能からの新しい応答を待っています</h2>
				<p>
					Moodleを開いたままお待ちください。新しい応答を確認すると自動的に正常状態へ戻ります。
				</p>
			</div>
		{:else if viewState === "stale" && observation}
			<div class="status-icon warning" aria-hidden="true">i</div>
			<div>
				<p class="section-label">再確認が必要です</p>
				<h2>拡張機能からの最終応答が古くなっています</h2>
				<p>
					最後の応答は {formatDate(observation.lastSeenAt)} です。削除とは断定せず、まずMoodleを開いて新しい応答を確認します。
				</p>
			</div>
		{:else if viewState === "missing" && observation}
			<div class="status-icon error" aria-hidden="true">!</div>
			<div>
				<p class="section-label">今回の起動後は未確認です</p>
				<h2>現在の拡張機能から応答がありません</h2>
				<p>
					前回は {formatDate(observation.lastSeenAt)} に応答がありました。今回の起動後の応答ではないため、接続中とは判定していません。Moodleを開いて再確認してください。
				</p>
			</div>
		{:else}
			<div class="status-icon error" aria-hidden="true">!</div>
			<div>
				<p class="section-label">応答を確認できません</p>
				<h2>拡張機能の状態を確認してください</h2>
				<p>
					拡張機能から最近の応答を確認できません。拡張機能が削除または無効化されているか、更新が必要な可能性があります。ブラウザで拡張機能を確認し、必要であれば最新版をインストールしてください。
				</p>
			</div>
		{/if}
	</section>

	<div class="actions">
		<button
			class="primary-button"
			type="button"
			on:click={() => startRecheck(true)}
			disabled={isManualRecheck || isOpening}
		>
			Moodleを開いて再確認
		</button>
		<button
			class="secondary-button"
			type="button"
			on:click={() => startRecheck(false)}
			disabled={isManualRecheck || isOpening}
		>
			{isManualRecheck ? "確認中..." : "応答を再確認"}
		</button>
		<button
			class="text-button"
			type="button"
			on:click={openInstallGuide}
			disabled={!destination.available || isOpening || isManualRecheck}
		>
			{isOpening ? "導入先を開いています..." : "拡張機能の導入手順を開く"}
		</button>
	</div>

	<p class="help">
		更新または再インストールした後はMoodleを開いてください。新しい応答を確認すると、この画面は自動的に復旧完了へ切り替わります。
	</p>

	<section
		class="maintenance-card"
		aria-labelledby="library-maintenance-heading"
	>
		<div>
			<p class="section-label">このPCのデータ</p>
			<h2 id="library-maintenance-heading">保存先・資料情報・バックアップ</h2>
			<p>
				別のPCへ復元した場合などは「保存先を変更」から新しいフォルダーを選べます。既存ルールを保持し、資料を移動・削除せずに保存先と検索・整理情報を更新します。操作の前に資料の保存完了を確認し、ブラウザを閉じてください。
			</p>
		</div>

		{#if maintenanceError}
			<p
				class:error-banner={!maintenanceSuccess}
				class:warning-banner={Boolean(maintenanceSuccess)}
				role="alert"
			>
				{maintenanceSuccess
					? `${maintenanceSuccess} ${maintenanceError}`
					: maintenanceError}
			</p>
		{:else if maintenanceSuccess}
			<p class="success-banner" role="status">{maintenanceSuccess}</p>
		{/if}
		{#if maintenanceProgress}
			<div class="maintenance-progress" aria-live="polite" aria-atomic="true">
				<div>
					<strong>{maintenanceProgressPresentation.title}</strong>
					<span>{maintenanceProgressPresentation.countLabel}</span>
				</div>
				<div
					class:indeterminate={maintenanceProgressPresentation.percent ===
						null && maintenanceProgress.state === "running"}
					class="maintenance-progress-track"
					role="progressbar"
					aria-label="資料情報の準備"
					aria-valuemin="0"
					aria-valuemax="100"
					aria-valuenow={maintenanceProgressPresentation.percent ?? undefined}
					aria-valuetext={maintenanceProgressPresentation.ariaValueText}
				>
					<span
						style:width={`${maintenanceProgressPresentation.percent ?? 30}%`}
					></span>
				</div>
				{#if maintenanceProgress?.phase !== "completed"}
					<p>{maintenanceProgressPresentation.availabilityLabel}</p>
				{/if}
			</div>
		{/if}

		<div class="maintenance-actions">
			<button
				class="secondary-button"
				type="button"
				on:click={changeLibraryRoot}
				disabled={maintenanceActionRunning}
			>
				{isChangingLibraryRoot
					? "保存先を変更し、資料情報を準備中..."
					: "保存先を変更"}
			</button>
			<button
				class="primary-button"
				type="button"
				on:click={rebuildLibrary}
				disabled={maintenanceActionRunning}
			>
				{isRebuildingLibrary
					? "資料情報を作り直しています..."
					: "保存先を確認して資料情報を作り直す"}
			</button>
			<button
				class="secondary-button"
				type="button"
				on:click={exportBackup}
				disabled={maintenanceActionRunning}
			>
				{isExportingBackup ? "書き出し中..." : "バックアップを書き出す"}
			</button>
			<button
				class="secondary-button"
				type="button"
				on:click={importBackup}
				disabled={maintenanceActionRunning}
			>
				{isImportingBackup
					? "復元し、資料情報を準備中..."
					: "バックアップから復元"}
			</button>
			<button
				class="secondary-button"
				type="button"
				on:click={repairNativeHost}
				disabled={maintenanceActionRunning}
			>
				{isRepairingNativeHost
					? "拡張機能との接続を修復中..."
					: "拡張機能との接続を自動修復"}
			</button>
		</div>

		{#if maintenanceSummary}
			<div class="maintenance-summary" aria-label="資料情報の準備結果">
				<div>
					<span>検出</span><strong>{maintenanceSummary.scannedFileCount}</strong
					>
				</div>
				<div>
					<span>新規登録</span><strong
						>{maintenanceSummary.registeredFileCount}</strong
					>
				</div>
				<div>
					<span>更新</span><strong>{maintenanceSummary.updatedFileCount}</strong
					>
				</div>
				<div>
					<span>検索準備</span><strong
						>{maintenanceSummary.indexedFileCount}</strong
					>
				</div>
				<div>
					<span>見つからない資料</span><strong
						>{maintenanceSummary.missingFileCount}</strong
					>
				</div>
				<div>
					<span>スキップ</span><strong
						>{maintenanceSummary.skippedFileCount}</strong
					>
				</div>
			</div>
		{/if}

		<p class="maintenance-note">
			復元前には確認ダイアログを表示します。バックアップの書き出しでは既存ファイルを上書きしません。
		</p>
	</section>
</section>

<style>
	.recovery-panel {
		width: min(100%, 880px);
		margin: 22px auto 0;
		padding: 28px;
		box-sizing: border-box;
		border-radius: 12px;
		background: var(--fuzzy-color-surface-glass);
		box-shadow: 0 28px 52px var(--fuzzy-color-primary-overlay);
	}

	.recovery-header,
	.status-card,
	.actions {
		display: flex;
		align-items: flex-start;
		gap: 16px;
	}

	.recovery-header {
		justify-content: space-between;
	}

	.chip,
	.local-badge {
		width: fit-content;
		border-radius: 999px;
		font-weight: 700;
	}

	.chip {
		margin: 0 0 12px;
		padding: 4px 10px;
		background: var(--fuzzy-color-primary-overlay);
		color: var(--fuzzy-color-primary);
		font-size: 0.7rem;
	}

	.local-badge {
		padding: 7px 12px;
		background: var(--fuzzy-color-success-soft);
		color: var(--fuzzy-color-success);
		font-size: 0.72rem;
		white-space: nowrap;
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
		margin-bottom: 6px;
		font-size: 1.05rem;
	}

	.intro,
	.status-card p:not(.section-label),
	.help {
		font-size: 0.8rem;
		line-height: 1.7;
		color: var(--fuzzy-color-text-muted);
	}

	.status-card,
	.error-banner,
	.warning-banner,
	.success-banner {
		margin-top: 22px;
		border-radius: 8px;
	}

	.status-card {
		padding: 20px;
		background: var(--fuzzy-color-surface-muted);
		border: 1px solid var(--fuzzy-color-border-overlay);
		color: var(--fuzzy-color-text);
	}

	.status-card.complete {
		background: var(--fuzzy-color-success-soft);
		border-color: var(--fuzzy-color-success);
	}

	.status-card.warning {
		background: var(--fuzzy-color-warning-soft);
		border-color: var(--fuzzy-color-warning-border);
	}

	.status-card.error {
		background: var(--fuzzy-color-danger-soft);
		border-color: var(--fuzzy-color-danger);
	}

	.status-icon {
		width: 28px;
		height: 28px;
		display: grid;
		place-items: center;
		flex: 0 0 auto;
		border-radius: 999px;
		font-weight: 700;
	}

	.status-icon.complete {
		background: var(--fuzzy-color-success);
		color: var(--fuzzy-color-surface);
	}

	.status-icon.warning {
		background: var(--fuzzy-color-warning);
		color: var(--fuzzy-color-surface);
	}

	.status-icon.error {
		background: var(--fuzzy-color-danger);
		color: var(--fuzzy-color-surface);
	}

	.status-icon.checking {
		width: 20px;
		height: 20px;
		border: 3px solid var(--fuzzy-color-primary-overlay);
		border-top-color: var(--fuzzy-color-primary);
		animation: spin 0.8s linear infinite;
	}

	.section-label {
		margin-bottom: 6px;
		font-size: 0.7rem;
		font-weight: 700;
		color: var(--fuzzy-color-text-muted);
	}

	.error-banner,
	.warning-banner,
	.success-banner {
		padding: 14px 16px;
		font-size: 0.8rem;
	}

	.error-banner {
		background: var(--fuzzy-color-danger-soft);
		border: 1px solid var(--fuzzy-color-danger);
		color: var(--fuzzy-color-danger);
	}

	.warning-banner {
		background: var(--fuzzy-color-warning-soft);
		border: 1px solid var(--fuzzy-color-warning-border);
		color: var(--fuzzy-color-warning);
	}

	.success-banner {
		background: var(--fuzzy-color-success-soft);
		border: 1px solid var(--fuzzy-color-success);
		color: var(--fuzzy-color-success);
	}

	.actions {
		margin-top: 22px;
		align-items: center;
		flex-wrap: wrap;
	}

	button {
		border: none;
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

	button:focus-visible {
		outline: 3px solid var(--fuzzy-focus-ring);
		outline-offset: 2px;
	}

	.primary-button {
		background: var(--fuzzy-color-primary);
		color: var(--fuzzy-color-surface);
	}

	.secondary-button {
		background: var(--fuzzy-color-primary-soft);
		color: var(--fuzzy-color-primary);
	}

	.actions > .secondary-button {
		min-width: 104px;
	}

	.text-button {
		background: transparent;
		color: var(--fuzzy-color-primary);
	}

	.help {
		margin: 18px 0 0;
		padding-top: 16px;
		border-top: 1px solid var(--fuzzy-color-border-overlay);
	}

	.maintenance-card {
		margin-top: 24px;
		padding: 20px;
		border: 1px solid var(--fuzzy-color-border-overlay);
		border-radius: 10px;
		background: var(--fuzzy-color-surface-muted);
	}

	.maintenance-card > div:first-child > p:not(.section-label),
	.maintenance-note {
		margin-bottom: 0;
		font-size: 0.78rem;
		line-height: 1.7;
		color: var(--fuzzy-color-text-muted);
	}

	.maintenance-actions {
		margin-top: 18px;
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
	}

	.maintenance-progress {
		display: grid;
		gap: 9px;
		margin-top: 14px;
		padding: 13px;
		border-radius: 10px;
		background: var(--fuzzy-color-page);
	}

	.maintenance-progress > div:first-child {
		display: flex;
		justify-content: space-between;
		gap: 12px;
	}

	.maintenance-progress p {
		margin: 0;
		color: var(--fuzzy-color-warning);
	}

	.maintenance-progress-track {
		height: 9px;
		overflow: hidden;
		border-radius: 999px;
		background: var(--fuzzy-color-border);
	}

	.maintenance-progress-track span {
		display: block;
		height: 100%;
		background: var(--fuzzy-color-primary);
		transition: width 0.2s ease;
	}

	.maintenance-progress-track.indeterminate span {
		animation: maintenance-progress 1.2s ease-in-out infinite alternate;
	}

	@keyframes maintenance-progress {
		from {
			transform: translateX(-35%);
		}
		to {
			transform: translateX(185%);
		}
	}

	.maintenance-summary {
		margin-top: 18px;
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 8px;
	}

	.maintenance-summary div {
		padding: 10px;
		display: grid;
		gap: 3px;
		border-radius: 8px;
		background: var(--fuzzy-color-surface);
		text-align: center;
	}

	.maintenance-summary span {
		font-size: 0.67rem;
		color: var(--fuzzy-color-text-muted);
	}

	.maintenance-summary strong {
		color: var(--fuzzy-color-primary);
		font-size: 1.05rem;
	}

	.maintenance-note {
		margin: 16px 0 0;
		padding-top: 14px;
		border-top: 1px solid var(--fuzzy-color-border-overlay);
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.status-icon.checking,
		.maintenance-progress-track.indeterminate span {
			animation: none;
		}

		.maintenance-progress-track span {
			transition: none;
		}
	}

	@media (max-width: 720px) {
		.recovery-panel {
			padding: 20px 16px;
		}

		.recovery-header,
		.actions,
		.maintenance-actions {
			flex-direction: column;
			align-items: stretch;
		}

		button {
			width: 100%;
		}

		.maintenance-summary {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
