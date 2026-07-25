<script lang="ts">
	import {
		changeLibraryRootClient,
		createFreshDatabaseClient,
		getApplicationRecoveryStatusClient,
		importBackupClient,
		rebuildLibraryClient,
	} from "./library-maintenance";
	import type { ApplicationRecoveryStatus } from "./library-maintenance";

	export let initialStatus: ApplicationRecoveryStatus;
	export let onRecovered: (message: string) => void = () => undefined;

	let status = initialStatus;
	let isRestoring = false;
	let isCreatingFresh = false;
	let isRebuilding = false;
	let isChangingRoot = false;
	let errorMessage: string | null = null;
	let successMessage: string | null = null;
	let recoveryCopyPath: string | null = null;

	async function refreshStatus(message: string): Promise<void> {
		status = await getApplicationRecoveryStatusClient();
		if (
			status.database.state === "ready" &&
			status.searchIndex.state === "ready"
		) {
			onRecovered(message);
		}
	}

	async function restoreBackup(): Promise<void> {
		isRestoring = true;
		errorMessage = null;
		successMessage = null;
		try {
			const result = await importBackupClient();
			if (result.cancelled) return;
			recoveryCopyPath = result.recoveryCopyPath ?? null;
			successMessage =
				"SQLiteバックアップを復元しました。保存済みの資料ファイルは変更していません。";
			if (result.maintenanceError) {
				errorMessage = result.maintenanceError;
			}
			await refreshStatus(
				result.recoveryCopyPath
					? `SQLiteバックアップを復元しました。開けなかったDBの保全先: ${result.recoveryCopyPath}`
					: "SQLiteバックアップを復元し、ローカルデータを復旧しました。",
			);
		} catch (error) {
			errorMessage =
				error instanceof Error
					? error.message
					: "バックアップから復元できませんでした。";
		} finally {
			isRestoring = false;
		}
	}

	async function createFreshDatabase(): Promise<void> {
		isCreatingFresh = true;
		errorMessage = null;
		successMessage = null;
		try {
			const result = await createFreshDatabaseClient();
			if (result.cancelled) return;
			recoveryCopyPath = result.recoveryCopyPath ?? null;
			successMessage =
				"開けなかったDBを別名で保全し、新しいSQLite正本を作成しました。保存済みの資料ファイルは変更していません。";
			if (result.indexError) {
				errorMessage = result.indexError;
			}
			await refreshStatus(
				`開けなかったDBを保全して新しく開始しました。保全先: ${result.recoveryCopyPath}。保存先と初期ルールを設定してください。`,
			);
		} catch (error) {
			errorMessage =
				error instanceof Error
					? error.message
					: "新しいSQLite正本を作成できませんでした。";
		} finally {
			isCreatingFresh = false;
		}
	}

	async function rebuildIndex(): Promise<void> {
		isRebuilding = true;
		errorMessage = null;
		successMessage = null;
		try {
			await rebuildLibraryClient();
			successMessage =
				"SQLite正本を基に検索索引を再構築しました。資料ファイルは変更していません。";
			await refreshStatus("検索索引を再構築し、ローカルデータを復旧しました。");
		} catch (error) {
			errorMessage =
				error instanceof Error
					? error.message
					: "検索索引を再構築できませんでした。";
		} finally {
			isRebuilding = false;
		}
	}

	async function changeLibraryRoot(): Promise<void> {
		isChangingRoot = true;
		errorMessage = null;
		successMessage = null;
		try {
			const result = await changeLibraryRootClient();
			if (result.cancelled) return;
			successMessage = `保存先を変更し、登録済み資料${result.rebasedFileCount}件の参照先を更新しました。資料ファイルは移動・削除していません。`;
			if (result.maintenanceError) {
				errorMessage = result.maintenanceError;
			}
			await refreshStatus(
				"保存先をこのPCのフォルダーへ変更し、検索索引を再構築しました。",
			);
		} catch (error) {
			errorMessage =
				error instanceof Error
					? error.message
					: "保存先を変更できませんでした。";
		} finally {
			isChangingRoot = false;
		}
	}

	$: databaseNeedsRecovery = status.database.state === "recoveryRequired";
	$: indexNeedsRecovery = status.searchIndex.state !== "ready";
	$: canChangeLibraryRoot = !databaseNeedsRecovery;
	$: isBusy = isRestoring || isCreatingFresh || isRebuilding || isChangingRoot;
</script>

<section class="recovery-panel" aria-labelledby="startup-recovery-heading">
	<header>
		<div>
			<p class="chip">ローカルデータの復旧</p>
			<h1 id="startup-recovery-heading">Fuzzyを安全に起動するための確認</h1>
			<p class="intro">
				SQLite正本または検索索引を開けませんでした。ターミナル操作は不要です。この画面から復旧しても、保存済みの授業資料は移動・削除しません。
			</p>
		</div>
		<span class="local-badge">ローカル完結</span>
	</header>

	{#if errorMessage}
		<p class="error-banner" role="alert">{errorMessage}</p>
	{/if}
	{#if successMessage}
		<p class="success-banner" role="status">{successMessage}</p>
	{/if}
	{#if recoveryCopyPath}
		<p class="copy-path" role="status">
			開けなかったDBの保全先: <strong>{recoveryCopyPath}</strong>
		</p>
	{/if}

	<div class="status-grid">
		<section class:problem={databaseNeedsRecovery} class="status-card">
			<p class="section-label">SQLite正本</p>
			<h2>{databaseNeedsRecovery ? "復旧が必要です" : "利用できます"}</h2>
			<p>{status.database.message}</p>
		</section>
		<section class:problem={indexNeedsRecovery} class="status-card">
			<p class="section-label">検索索引</p>
			<h2>{indexNeedsRecovery ? "再構築が必要です" : "利用できます"}</h2>
			<p>{status.searchIndex.message}</p>
		</section>
	</div>

	{#if databaseNeedsRecovery}
		<section class="action-card">
			<h2>1. バックアップがある場合</h2>
			<p>
				「バックアップから復元」を押し、Fuzzyが書き出したSQLiteファイルを選んでください。復元前に確認ダイアログを表示します。
			</p>
			<button
				class="primary-button"
				type="button"
				on:click={restoreBackup}
				disabled={isBusy}
			>
				{isRestoring ? "復元中..." : "バックアップから復元"}
			</button>
		</section>

		<section class="action-card caution">
			<h2>2. バックアップがない場合</h2>
			<p>
				開けないDBと付随ファイルを別名の復旧用フォルダーへ保全してから、新しいSQLite正本を作成します。設定と履歴は初期状態になります。実行前にもう一度確認します。
			</p>
			<button
				class="secondary-button"
				type="button"
				on:click={createFreshDatabase}
				disabled={isBusy}
			>
				{isCreatingFresh ? "保全・作成中..." : "破損DBを保全して新しく開始"}
			</button>
		</section>
	{:else if indexNeedsRecovery}
		{#if canChangeLibraryRoot}
			<section class="action-card">
				<h2>バックアップ元の保存先がこのPCにない場合</h2>
				<p>
					別のPCで作成したバックアップなど、以前の保存先を開けない場合は、このPCで資料を置いているフォルダーへ設定だけを変更できます。資料ファイルは移動・削除しません。
				</p>
				<button
					class="secondary-button"
					type="button"
					on:click={changeLibraryRoot}
					disabled={isBusy}
				>
					{isChangingRoot ? "保存先を変更中..." : "保存先を変更"}
				</button>
			</section>
		{/if}

		<section class="action-card">
			<h2>検索索引だけを復旧</h2>
			<p>
				SQLite正本は正常です。開けない索引を別名で退避し、SQLiteと保存先の資料から内部索引だけを作り直します。
			</p>
			<button
				class="primary-button"
				type="button"
				on:click={rebuildIndex}
				disabled={isBusy}
			>
				{isRebuilding ? "再構築中..." : "検索索引を再構築"}
			</button>
		</section>
	{/if}

	<p class="safety-note">
		復旧対象はFuzzyのSQLiteと派生検索索引だけです。授業資料の自動移動・自動削除、外部送信は行いません。
	</p>
</section>

<style>
	.recovery-panel {
		width: min(100%, 880px);
		margin: 22px auto;
		padding: 28px;
		box-sizing: border-box;
		border-radius: 12px;
		background: rgba(255, 255, 255, 0.97);
		box-shadow: 0 28px 52px rgba(96, 105, 151, 0.16);
	}

	header {
		display: flex;
		justify-content: space-between;
		gap: 20px;
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

	.chip,
	.local-badge {
		width: fit-content;
		border-radius: 999px;
		font-weight: 700;
	}

	.chip {
		margin-bottom: 12px;
		padding: 4px 10px;
		background: #fff2f0;
		color: #a03d2f;
		font-size: 0.7rem;
	}

	.local-badge {
		height: fit-content;
		padding: 7px 12px;
		background: #edf8f1;
		color: #2e6b43;
		font-size: 0.72rem;
		white-space: nowrap;
	}

	.intro,
	.status-card p:not(.section-label),
	.action-card p,
	.safety-note {
		color: #727894;
		font-size: 0.8rem;
		line-height: 1.7;
	}

	.error-banner,
	.success-banner,
	.copy-path {
		margin: 18px 0 0;
		padding: 13px 15px;
		border-radius: 8px;
		font-size: 0.78rem;
		overflow-wrap: anywhere;
	}

	.error-banner {
		background: #fff2f0;
		border: 1px solid #f2c5bd;
		color: #9d3426;
	}

	.success-banner {
		background: #edf8f1;
		border: 1px solid #b9e2c7;
		color: #2e6b43;
	}

	.copy-path {
		background: #f5f6fb;
		border: 1px solid #d9dceb;
		color: #525978;
	}

	.status-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
		margin-top: 22px;
	}

	.status-card,
	.action-card {
		padding: 18px;
		border: 1px solid #d9dceb;
		border-radius: 10px;
		background: #f8f9ff;
	}

	.status-card.problem {
		background: #fff7f5;
		border-color: #edc5bc;
	}

	.section-label {
		margin-bottom: 6px;
		color: #7d83a2;
		font-size: 0.7rem;
		font-weight: 700;
	}

	.action-card {
		margin-top: 14px;
	}

	.action-card.caution {
		background: #fff9e8;
		border-color: #ead59a;
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
		outline: 3px solid rgba(109, 92, 246, 0.3);
		outline-offset: 2px;
	}

	.primary-button {
		background: var(--fuzzy-color-primary);
		color: #fff;
	}

	.secondary-button {
		background: #fff;
		border: 1px solid #d7b866;
		color: #795c00;
	}

	.safety-note {
		margin: 18px 0 0;
		padding-top: 16px;
		border-top: 1px solid #e0e2ee;
	}

	@media (max-width: 720px) {
		.recovery-panel {
			padding: 20px 16px;
		}

		header,
		.status-grid {
			grid-template-columns: 1fr;
			flex-direction: column;
		}

		button {
			width: 100%;
		}
	}
</style>
