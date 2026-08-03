<script lang="ts">
	import { onMount } from "svelte";
	import type { ExtensionSetupStatus } from "@fuzzy/shared";
	import {
		ExtensionInstallError,
		getExtensionInstallDestination,
		getNativeHostInstallationStatusClient,
		getExtensionSetupStatusClient,
		getPreferredExtensionInstallChannel,
		openExtensionInstallDestinationClient,
		repairNativeHostInstallationClient,
	} from "./extension-install";
	import type { NativeHostInstallationStatus } from "./extension-install";
	import { userFacingOperationError } from "./application-state";

	export let onComplete: () => void = () => undefined;
	export let verificationStartedAt: string = new Date().toISOString();

	const selectedChannel = getPreferredExtensionInstallChannel();
	const destination = getExtensionInstallDestination(selectedChannel);
	const statusPollIntervalMs = 1000;

	let setupStatus: ExtensionSetupStatus = {
		state: "waiting",
		observation: null,
	};
	let isOpening = false;
	let isRefreshing = false;
	let errorMessage: string | null = null;
	let successMessage: string | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let nativeHostStatus: NativeHostInstallationStatus | null = null;
	let isRepairingNativeHost = false;

	onMount(() => {
		void refreshNativeHostStatus();
		void refreshStatus();
		pollTimer = setInterval(() => {
			void refreshStatus();
		}, statusPollIntervalMs);

		return () => {
			if (pollTimer) clearInterval(pollTimer);
		};
	});

	async function refreshNativeHostStatus(): Promise<void> {
		try {
			nativeHostStatus = await getNativeHostInstallationStatusClient();
		} catch (error) {
			nativeHostStatus = {
				ready: false,
				message:
					error instanceof Error
						? error.message
						: "拡張機能との接続状態を確認できませんでした。Fuzzyを再起動してから再試行してください。",
			};
		}
	}

	async function handleRepairNativeHost(): Promise<void> {
		if (isRepairingNativeHost || isOpening) return;
		isRepairingNativeHost = true;
		errorMessage = null;
		successMessage = null;
		try {
			nativeHostStatus = await repairNativeHostInstallationClient();
			if (nativeHostStatus.ready) {
				successMessage =
					"拡張機能との接続を自動修復しました。拡張機能の導入を続けてください。";
			} else {
				errorMessage =
					"拡張機能との接続を自動修復できませんでした。Fuzzyを再起動してから再試行してください。";
			}
		} catch (error) {
			errorMessage = userFacingOperationError(
				error,
				"拡張機能との接続を自動修復できませんでした。Fuzzyを再起動してから再試行してください。",
			);
		} finally {
			isRepairingNativeHost = false;
		}
	}

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

	function getOpenErrorMessage(error: unknown): string {
		if (error instanceof ExtensionInstallError) return error.message;
		return "拡張機能の導入先を開けませんでした。時間をおいて再試行してください。";
	}

	async function refreshStatus(): Promise<void> {
		if (isRefreshing || setupStatus.state === "ready") return;

		isRefreshing = true;
		try {
			setupStatus = await getExtensionSetupStatusClient(verificationStartedAt);
			errorMessage = null;
			if (setupStatus.state === "ready" && pollTimer) {
				clearInterval(pollTimer);
				pollTimer = null;
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

	async function handleOpenDestination(): Promise<void> {
		if (isOpening || isRepairingNativeHost) return;
		isOpening = true;
		errorMessage = null;
		successMessage = null;

		try {
			const result =
				await openExtensionInstallDestinationClient(selectedChannel);
			if (result.mocked) {
				successMessage =
					"このプレビューでは導入先を開きません。Fuzzyのデスクトップアプリで導入操作を確認してください。";
			} else if (result.destination.kind === "bundled") {
				successMessage =
					"拡張機能のフォルダーを表示しました。ブラウザに追加すると自動確認を始めます。";
			} else {
				successMessage =
					"Fuzzyの公式配布ページを既定のブラウザで開きました。導入後、この画面へ戻ってください。";
			}
		} catch (error) {
			errorMessage = getOpenErrorMessage(error);
		} finally {
			isOpening = false;
		}
	}

	$: isReady =
		setupStatus.state === "ready" && setupStatus.observation !== null;
	$: isIncompatible =
		setupStatus.state === "incompatible" && setupStatus.observation !== null;
</script>

<section class="install-panel" aria-labelledby="extension-install-heading">
	<header class="install-header">
		<div>
			<h1 id="extension-install-heading" tabindex="-1">
				ブラウザ拡張機能を導入
			</h1>
			<p class="intro">
				Fuzzyを使うには、使っているブラウザにFuzzy拡張機能を追加して設定します。追加が終わると、この画面で自動的に確認します。
			</p>
		</div>
		<span class="local-badge">あなたのPC上で確認</span>
	</header>

	<section class="safety-card" aria-labelledby="safety-heading">
		<div class="safety-icon" aria-hidden="true">i</div>
		<div>
			<h2 id="safety-heading">導入操作はブラウザ上で行います</h2>
			<p>
				拡張機能の追加と設定は、ブラウザの拡張機能管理画面で行います。表示される権限を確認して、ユーザー自身で追加してください。
			</p>
		</div>
	</section>

	<section class="distribution-card" aria-labelledby="distribution-heading">
		<div>
			<p class="section-label">現在の導入方法</p>
			<h2 id="distribution-heading">{destination.label}</h2>
			<p>
				{#if selectedChannel === "store"}
					公式配布ページを既定のブラウザで開きます。
				{:else}
					Fuzzy拡張機能のフォルダーはアプリに含まれています。ブラウザの管理画面から追加してください。
				{/if}
			</p>
		</div>
		<span class:store={selectedChannel === "store"} class="distribution-badge">
			{selectedChannel === "store" ? "公式配布" : "拡張機能のフォルダー"}
		</span>
	</section>

	{#if nativeHostStatus && !nativeHostStatus.ready}
		<section class="host-error-card" aria-labelledby="connection-error-heading">
			<div>
				<p class="section-label">自動セットアップを確認してください</p>
				<h2 id="connection-error-heading">
					拡張機能との接続を準備できませんでした
				</h2>
				<p>
					「接続を自動修復」を押してください。解決しない場合はFuzzyを再起動して、もう一度お試しください。
				</p>
			</div>
			<button
				class="refresh-button"
				type="button"
				on:click={handleRepairNativeHost}
				disabled={isRepairingNativeHost}
			>
				{isRepairingNativeHost ? "接続を修復中..." : "接続を自動修復"}
			</button>
		</section>
	{/if}

	<section class="guide-card" aria-labelledby="install-guide-heading">
		<div class="guide-heading">
			<div>
				<p class="section-label">導入手順</p>
				<h2 id="install-guide-heading">対応するブラウザへFuzzyを追加する</h2>
			</div>
		</div>

		{#if selectedChannel === "store"}
			<ol class="guide-list">
				<li>
					<span class="guide-index">1</span>
					<div>
						<strong>公式配布ページを開く</strong>
						<p>下のボタンからFuzzyの拡張機能詳細ページを開きます。</p>
					</div>
				</li>
				<li>
					<span class="guide-index">2</span>
					<div>
						<strong>拡張機能を追加する</strong>
						<p>
							ブラウザの追加ボタンを押し、権限を確認して導入します。導入後はこの画面へ戻ります。
						</p>
					</div>
				</li>
			</ol>
		{:else}
			<ol class="guide-list">
				<li>
					<span class="guide-index">1</span>
					<div>
						<strong>拡張機能のフォルダーを表示する</strong>
						<p>
							下のボタンを押すと、Fuzzy拡張機能が入ったフォルダーをエクスプローラーで表示します。
						</p>
					</div>
				</li>
				<li>
					<span class="guide-index">2</span>
					<div>
						<strong>ブラウザの拡張機能管理画面を開く</strong>
						<p>
							ブラウザ上部の検索バーに、Chrome・Chromiumなら <code
								class="browser-address">chrome://extensions/</code
							>、Edgeなら
							<code class="browser-address">edge://extensions/</code> と入力して開きます。画面右上の「デベロッパーモード」をオンにしてください。
						</p>
					</div>
				</li>
				<li>
					<span class="guide-index">3</span>
					<div>
						<strong>表示したフォルダーを拡張機能として追加する</strong>
						<p>
							「パッケージ化されていない拡張機能を読み込む」を押し、先ほど表示したフォルダーを選びます。<code
								>manifest.json</code
							>が入っているフォルダーを指定してください。追加後、ブラウザでMoodleを開くとFuzzyが接続を確認します。
						</p>
					</div>
				</li>
			</ol>
		{/if}
	</section>

	{#if errorMessage}
		<p class="error-banner" role="alert">{errorMessage}</p>
	{/if}

	{#if successMessage}
		<p class="success-banner" role="status">{successMessage}</p>
	{/if}

	<div class="install-actions">
		<button
			class="primary-button"
			type="button"
			on:click={handleOpenDestination}
			disabled={!destination.available || isOpening}
			aria-busy={isOpening}
		>
			{isOpening
				? "導入先を開いています..."
				: selectedChannel === "store"
					? "Fuzzyの公式配布ページを開く"
					: "拡張機能のフォルダーを表示"}
		</button>
	</div>

	<section
		class:complete={isReady}
		class:error={isIncompatible}
		class="response-card"
	>
		{#if isReady && setupStatus.observation}
			<div class="response-icon complete" aria-hidden="true">✓</div>
			<div>
				<p class="section-label">応答確認済み</p>
				<h2>拡張機能の導入を確認しました</h2>
				<p>
					拡張機能バージョン {setupStatus.observation.extensionVersion}から
					{formatDate(setupStatus.observation.lastSeenAt)} に応答がありました。画面下の「セットアップを完了」を押してください。
				</p>
			</div>
		{:else if isIncompatible && setupStatus.observation}
			<div class="response-icon error" aria-hidden="true">!</div>
			<div>
				<p class="section-label">更新が必要です</p>
				<h2>現在の拡張機能はこのアプリに対応していません</h2>
				<p>
					確認した拡張機能はバージョン {setupStatus.observation
						.extensionVersion}です。上の導入手順から最新版を導入し、Moodleを開いて再確認してください。
				</p>
			</div>
		{:else}
			<div class="response-icon waiting" aria-hidden="true"></div>
			<div>
				<p class="section-label">自動確認中</p>
				<h2>拡張機能からの応答を待っています</h2>
				<p>
					拡張機能を導入した後、Moodleを開いてください。Fuzzyが接続を確認すると、この画面は自動的に完了へ切り替わります。
				</p>
				<button
					class="refresh-button"
					type="button"
					on:click={refreshStatus}
					disabled={isRefreshing}
				>
					{isRefreshing ? "確認中..." : "応答を再確認"}
				</button>
			</div>
		{/if}
	</section>

	{#if isReady}
		<button class="complete-button" type="button" on:click={onComplete}>
			セットアップを完了
		</button>
	{/if}
</section>

<style>
	.install-panel {
		width: min(100%, 980px);
		margin: 22px auto 0;
		padding: 26px 28px 24px;
		box-sizing: border-box;
		border-radius: 12px;
		background: var(--fuzzy-color-surface-glass);
		box-shadow: 0 28px 52px var(--fuzzy-color-primary-overlay);
	}

	.install-header,
	.guide-heading,
	.install-actions,
	.distribution-card,
	.response-card {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
	}

	.local-badge,
	.distribution-badge {
		width: fit-content;
		border-radius: 999px;
		font-weight: 700;
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
	p,
	ol {
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

	.intro {
		max-width: 700px;
		margin-bottom: 0;
		font-size: 0.82rem;
		line-height: 1.7;
		color: var(--fuzzy-color-text-muted);
	}

	.safety-card,
	.distribution-card,
	.host-error-card,
	.guide-card,
	.response-card,
	.error-banner,
	.success-banner {
		margin-top: 20px;
		border-radius: 8px;
	}

	.safety-card {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 16px 18px;
		background: var(--fuzzy-color-primary-soft);
		border: 1px solid var(--fuzzy-color-primary-overlay);
		color: var(--fuzzy-color-text);
	}

	.host-error-card {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 16px 18px;
		border: 1px solid var(--fuzzy-color-danger);
		background: var(--fuzzy-color-danger-soft);
		color: var(--fuzzy-color-danger);
	}

	.host-error-card p:not(.section-label) {
		margin: 5px 0 0;
		font-size: 0.78rem;
		line-height: 1.65;
	}

	.safety-card p,
	.distribution-card p:not(.section-label),
	.response-card p:not(.section-label) {
		margin: 5px 0 0;
		font-size: 0.78rem;
		line-height: 1.65;
	}

	.safety-icon,
	.response-icon {
		width: 26px;
		height: 26px;
		display: grid;
		place-items: center;
		flex: 0 0 auto;
		border-radius: 999px;
		font-size: 0.75rem;
		font-weight: 700;
	}

	.safety-icon {
		background: var(--fuzzy-color-primary);
		color: var(--fuzzy-color-surface);
	}

	.distribution-card {
		padding: 18px 20px;
		background: linear-gradient(
			180deg,
			var(--fuzzy-color-primary-soft) 0%,
			var(--fuzzy-color-primary-soft) 100%
		);
		border: 1px solid var(--fuzzy-color-primary-overlay);
		color: var(--fuzzy-color-text);
	}

	.distribution-badge {
		padding: 6px 10px;
		background: var(--fuzzy-color-primary-soft);
		color: var(--fuzzy-color-primary);
		font-size: 0.68rem;
		white-space: nowrap;
	}

	.distribution-badge.store {
		background: var(--fuzzy-color-success-soft);
		color: var(--fuzzy-color-success);
	}

	.guide-card {
		padding: 20px;
		background: linear-gradient(
			180deg,
			var(--fuzzy-color-surface-muted) 0%,
			var(--fuzzy-color-surface-muted) 100%
		);
		border: 1px solid var(--fuzzy-color-border-overlay);
	}

	.section-label {
		margin-bottom: 6px;
		font-size: 0.7rem;
		font-weight: 700;
		color: var(--fuzzy-color-text-muted);
		text-transform: uppercase;
	}

	.guide-list {
		margin-bottom: 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: 10px;
	}

	.guide-list li {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 12px 14px;
		border-radius: 8px;
		background: var(--fuzzy-color-surface-glass);
		border: 1px solid var(--fuzzy-color-border-overlay);
	}

	.guide-index {
		width: 22px;
		height: 22px;
		display: grid;
		place-items: center;
		flex: 0 0 auto;
		border-radius: 999px;
		background: var(--fuzzy-color-primary);
		color: var(--fuzzy-color-surface);
		font-size: 0.7rem;
		font-weight: 700;
	}

	.guide-list strong {
		font-size: 0.8rem;
		color: var(--fuzzy-color-text);
	}

	.guide-list p {
		margin: 5px 0 0;
		font-size: 0.75rem;
		line-height: 1.65;
		color: var(--fuzzy-color-text-muted);
	}

	.error-banner,
	.success-banner {
		padding: 14px 16px;
		font-size: 0.8rem;
	}

	.error-banner {
		background: var(--fuzzy-color-danger-soft);
		border: 1px solid var(--fuzzy-color-danger);
		color: var(--fuzzy-color-danger);
	}

	.success-banner {
		background: var(--fuzzy-color-success-soft);
		border: 1px solid var(--fuzzy-color-success);
		color: var(--fuzzy-color-success);
	}

	.install-actions {
		margin-top: 20px;
		align-items: center;
	}

	button {
		border: none;
		border-radius: 8px;
		font: inherit;
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

	.primary-button,
	.refresh-button {
		padding: 12px 15px;
		font-weight: 700;
	}

	.primary-button {
		background: linear-gradient(
			180deg,
			var(--fuzzy-color-primary) 0%,
			var(--fuzzy-color-primary) 100%
		);
		color: var(--fuzzy-color-surface);
		box-shadow: 0 12px 24px var(--fuzzy-color-primary-overlay);
	}

	.complete-button {
		width: 100%;
		margin-top: 18px;
		padding: 14px 16px;
		border: 1px solid var(--fuzzy-color-success);
		border-radius: 8px;
		background: var(--fuzzy-color-surface);
		color: var(--fuzzy-color-success);
		font: inherit;
		font-weight: 800;
		cursor: pointer;
	}

	.complete-button:hover {
		background: var(--fuzzy-color-success-soft);
	}

	.complete-button:focus-visible {
		outline: 3px solid var(--fuzzy-focus-ring);
		outline-offset: 2px;
	}

	.response-card {
		justify-content: flex-start;
		padding: 18px 20px;
		background: var(--fuzzy-color-surface-muted);
		border: 1px solid var(--fuzzy-color-border-overlay);
		color: var(--fuzzy-color-text);
	}

	.response-card.complete {
		background: var(--fuzzy-color-success-soft);
		border-color: var(--fuzzy-color-success);
		color: var(--fuzzy-color-success);
	}

	.response-card.error {
		background: var(--fuzzy-color-danger-soft);
		border-color: var(--fuzzy-color-danger);
		color: var(--fuzzy-color-danger);
	}

	.response-icon.complete {
		background: var(--fuzzy-color-success);
		color: var(--fuzzy-color-surface);
	}

	.response-icon.error {
		background: var(--fuzzy-color-danger);
		color: var(--fuzzy-color-surface);
	}

	.response-icon.waiting {
		width: 20px;
		height: 20px;
		border: 3px solid var(--fuzzy-color-primary-overlay);
		border-top-color: var(--fuzzy-color-primary);
		animation: spin 0.8s linear infinite;
	}

	.refresh-button {
		margin-top: 12px;
		background: var(--fuzzy-color-primary-soft);
		color: var(--fuzzy-color-primary);
		font-size: 0.76rem;
	}

	code {
		display: inline-block;
		padding: 2px 6px;
		border: 1px solid var(--fuzzy-color-primary-overlay-strong);
		border-radius: 5px;
		background: var(--fuzzy-color-primary-soft);
		color: var(--fuzzy-color-primary-strong);
		font-family: Consolas, "Cascadia Mono", monospace;
		font-size: 0.95em;
		font-weight: 800;
		white-space: nowrap;
	}

	.browser-address {
		box-shadow: 0 0 0 2px var(--fuzzy-color-primary-overlay);
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (max-width: 720px) {
		.install-panel {
			padding: 20px 16px 18px;
		}

		.install-header,
		.install-actions,
		.distribution-card,
		.guide-heading {
			flex-direction: column;
			align-items: stretch;
		}

		.primary-button,
		.refresh-button {
			width: 100%;
		}
	}
</style>
