<script lang="ts">
	import { onMount } from "svelte";
	import type { ExtensionRecoveryStatus } from "@fuzzy/shared";
	import {
		ExtensionInstallError,
		getExtensionInstallDestination,
		getPreferredExtensionInstallChannel,
		openExtensionInstallDestinationClient,
	} from "./extension-install";
	import {
		deriveExtensionRecoveryViewState,
		getExtensionRecoveryStatusClient,
		openMoodleForRecoveryClient,
	} from "./extension-recovery";

	export let initialStatus: ExtensionRecoveryStatus;

	const selectedChannel = getPreferredExtensionInstallChannel();
	const destination = getExtensionInstallDestination(selectedChannel);
	const pollIntervalMs = 1000;

	let status = initialStatus;
	let recheckStartedAt: string | null = null;
	let nowMs = Date.now();
	let isRefreshing = false;
	let isOpening = false;
	let errorMessage: string | null = null;
	let successMessage: string | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	onMount(() => {
		pollTimer = setInterval(() => {
			if (status.state === "ready" && !recheckStartedAt) return;
			nowMs = Date.now();
			void refreshStatus();
		}, pollIntervalMs);

		return () => {
			if (pollTimer) clearInterval(pollTimer);
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

	async function refreshStatus(): Promise<void> {
		if (isRefreshing) return;
		isRefreshing = true;
		try {
			const wasReady = status.state === "ready";
			status = await getExtensionRecoveryStatusClient();
			errorMessage = null;
			if (status.state === "ready") {
				recheckStartedAt = null;
				if (!wasReady) {
					successMessage =
						"拡張機能から新しい応答を確認しました。復旧は完了です。";
				}
			}
		} catch (error) {
			errorMessage =
				error instanceof Error
					? error.message
					: "拡張機能の応答情報を確認できませんでした。";
		} finally {
			isRefreshing = false;
		}
	}

	async function startRecheck(openMoodle: boolean): Promise<void> {
		errorMessage = null;
		successMessage = null;
		if (openMoodle) {
			try {
				await openMoodleForRecoveryClient();
				successMessage =
					"Moodleを既定のブラウザで開きました。拡張機能からの新しい応答を待っています。";
			} catch (error) {
				errorMessage =
					error instanceof ExtensionInstallError
						? error.message
						: "Moodleを開けませんでした。";
				recheckStartedAt = null;
				return;
			}
		}
		recheckStartedAt = new Date().toISOString();
		nowMs = Date.now();
		await refreshStatus();
	}

	async function openInstallGuide(): Promise<void> {
		isOpening = true;
		errorMessage = null;
		successMessage = null;
		try {
			const result =
				await openExtensionInstallDestinationClient(selectedChannel);
			successMessage = result.mocked
				? "ブラウザプレビューでは導入先を開きません。Tauriアプリで確認してください。"
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

	$: viewState = deriveExtensionRecoveryViewState(
		status,
		recheckStartedAt,
		nowMs,
	);
	$: observation = status.observation;
</script>

<section class="recovery-panel" aria-labelledby="extension-recovery-heading">
	<header class="recovery-header">
		<div>
			<p class="chip">拡張機能の状態</p>
			<h1 id="extension-recovery-heading">Fuzzyの利用状態を確認</h1>
			<p class="intro">
				SQLiteに保存された拡張機能の最終応答とバージョンを確認します。ブラウザの種類による判定は行いません。
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

	<section
		class:complete={viewState === "ready"}
		class:warning={viewState === "stale" || viewState === "checking"}
		class:error={viewState === "timed-out" ||
			viewState === "incompatible" ||
			viewState === "missing"}
		class="status-card"
	>
		{#if viewState === "ready" && observation}
			<div class="status-icon complete" aria-hidden="true">✓</div>
			<div>
				<p class="section-label">正常</p>
				<h2>拡張機能から最近の応答を確認しました</h2>
				<p>
					バージョン {observation.extensionVersion}（通信仕様
					{observation.protocolVersion}）から
					{formatDate(observation.lastSeenAt)} に応答がありました。
				</p>
			</div>
		{:else if viewState === "incompatible" && observation}
			<div class="status-icon error" aria-hidden="true">!</div>
			<div>
				<p class="section-label">更新が必要です</p>
				<h2>現在の拡張機能はこのアプリのバージョンに対応していません</h2>
				<p>
					確認したバージョンは {observation.extensionVersion}（通信仕様
					{observation.protocolVersion}）です。最新版の拡張機能をインストールしてください。
				</p>
			</div>
		{:else if viewState === "checking"}
			<div class="status-icon checking" aria-hidden="true"></div>
			<div>
				<p class="section-label">再確認中</p>
				<h2>拡張機能からの新しい応答を待っています</h2>
				<p>
					Moodleを開いたままお待ちください。互換性のある応答を受信すると自動的に正常状態へ戻ります。
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
			disabled={isRefreshing}
		>
			Moodleを開いて再確認
		</button>
		<button
			class="secondary-button"
			type="button"
			on:click={() => startRecheck(false)}
			disabled={isRefreshing}
		>
			{isRefreshing ? "確認中..." : "応答を再確認"}
		</button>
		<button
			class="text-button"
			type="button"
			on:click={openInstallGuide}
			disabled={!destination.available || isOpening}
		>
			{isOpening ? "導入先を開いています..." : "拡張機能の導入手順を開く"}
		</button>
	</div>

	<p class="help">
		更新または再インストールした後はMoodleを開いてください。互換性のある新しい応答を受信すると、この画面は自動的に復旧完了へ切り替わります。
	</p>
</section>

<style>
	.recovery-panel {
		width: min(100%, 880px);
		margin: 22px auto 0;
		padding: 28px;
		box-sizing: border-box;
		border-radius: 12px;
		background: rgba(255, 255, 255, 0.96);
		box-shadow: 0 28px 52px rgba(96, 105, 151, 0.16);
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
		background: rgba(122, 107, 246, 0.1);
		color: var(--fuzzy-color-primary);
		font-size: 0.7rem;
	}

	.local-badge {
		padding: 7px 12px;
		background: #edf8f1;
		color: #2e6b43;
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
		color: #727894;
	}

	.status-card,
	.error-banner,
	.success-banner {
		margin-top: 22px;
		border-radius: 8px;
	}

	.status-card {
		padding: 20px;
		background: #f5f6fb;
		border: 1px solid rgba(203, 207, 226, 0.82);
		color: #525978;
	}

	.status-card.complete {
		background: #edf8f1;
		border-color: #b9e2c7;
	}

	.status-card.warning {
		background: #fff9e8;
		border-color: #ead59a;
	}

	.status-card.error {
		background: #fff2f0;
		border-color: #f2c5bd;
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
		background: #4d9c67;
		color: #fff;
	}

	.status-icon.warning {
		background: #c58a17;
		color: #fff;
	}

	.status-icon.error {
		background: #ab3e2d;
		color: #fff;
	}

	.status-icon.checking {
		width: 20px;
		height: 20px;
		border: 3px solid rgba(109, 92, 246, 0.2);
		border-top-color: var(--fuzzy-color-primary);
		animation: spin 0.8s linear infinite;
	}

	.section-label {
		margin-bottom: 6px;
		font-size: 0.7rem;
		font-weight: 700;
		color: #7d83a2;
	}

	.error-banner,
	.success-banner {
		padding: 14px 16px;
		font-size: 0.8rem;
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
		outline: 3px solid rgba(109, 92, 246, 0.3);
		outline-offset: 2px;
	}

	.primary-button {
		background: var(--fuzzy-color-primary);
		color: #fff;
	}

	.secondary-button {
		background: #edeaff;
		color: #6256ca;
	}

	.text-button {
		background: transparent;
		color: #6256ca;
	}

	.help {
		margin: 18px 0 0;
		padding-top: 16px;
		border-top: 1px solid rgba(203, 207, 226, 0.82);
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (max-width: 720px) {
		.recovery-panel {
			padding: 20px 16px;
		}

		.recovery-header,
		.actions {
			flex-direction: column;
			align-items: stretch;
		}

		button {
			width: 100%;
		}
	}
</style>
