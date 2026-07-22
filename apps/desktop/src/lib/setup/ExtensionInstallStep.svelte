<script lang="ts">
	import { onMount } from "svelte";
	import type { ExtensionSetupStatus } from "@fuzzy/shared";
	import {
		ExtensionInstallError,
		getExtensionInstallDestination,
		getExtensionSetupStatusClient,
		getPreferredExtensionInstallChannel,
		openExtensionInstallDestinationClient,
	} from "./extension-install";

	export let onBack: () => void = () => undefined;
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

	onMount(() => {
		void refreshStatus();
		pollTimer = setInterval(() => {
			void refreshStatus();
		}, statusPollIntervalMs);

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
		isOpening = true;
		errorMessage = null;
		successMessage = null;

		try {
			const result =
				await openExtensionInstallDestinationClient(selectedChannel);
			if (result.mocked) {
				successMessage =
					"ブラウザプレビューでは外部アプリを開きません。Tauriアプリで導入操作を確認してください。";
			} else if (result.destination.kind === "bundled") {
				successMessage =
					"同梱された拡張機能フォルダーを表示しました。読み込み後、拡張機能からの応答を自動確認します。";
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
			<p class="chip">STEP 4 / 4</p>
			<h1 id="extension-install-heading">ブラウザ拡張機能を導入</h1>
			<p class="intro">
				Fuzzyは拡張機能を前提とするため、拡張機能から実際の応答を確認すると初期セットアップが完了します。ブラウザの種類を選ぶ必要はありません。
			</p>
		</div>
		<span class="local-badge">ローカル完結</span>
	</header>

	<section class="safety-card" aria-labelledby="safety-heading">
		<div class="safety-icon" aria-hidden="true">i</div>
		<div>
			<h2 id="safety-heading">導入操作はブラウザ上で行います</h2>
			<p>
				Fuzzyは導入先を表示し、応答を確認するだけです。拡張機能の追加は、表示される権限を確認してユーザー自身で行います。確認通信はNative
				MessagingとローカルSQLiteだけで完結します。
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
					拡張機能はFuzzyアプリに同梱済みです。利用者によるビルドやコマンド操作は必要ありません。
				{/if}
			</p>
		</div>
		<span class:store={selectedChannel === "store"} class="distribution-badge">
			{selectedChannel === "store" ? "公式配布" : "アプリ同梱"}
		</span>
	</section>

	<section class="guide-card" aria-labelledby="install-guide-heading">
		<div class="guide-heading">
			<div>
				<p class="section-label">導入手順</p>
				<h2 id="install-guide-heading">対応するブラウザへFuzzyを追加する</h2>
			</div>
			<span class="step-count">
				{selectedChannel === "store" ? "2ステップ" : "3ステップ"}
			</span>
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
						<strong>同梱フォルダーを表示する</strong>
						<p>下のボタンを押すと、拡張機能のフォルダーを表示します。</p>
					</div>
				</li>
				<li>
					<span class="guide-index">2</span>
					<div>
						<strong>拡張機能の管理画面を開く</strong>
						<p>
							利用するブラウザの拡張機能管理画面を開き、デベロッパーモードを有効にします。
						</p>
					</div>
				</li>
				<li>
					<span class="guide-index">3</span>
					<div>
						<strong>表示したフォルダーを読み込む</strong>
						<p>
							「パッケージ化されていない拡張機能を読み込む」に相当する操作で、表示したフォルダーを指定します。
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
			class="text-button"
			type="button"
			on:click={onBack}
			disabled={isOpening}
		>
			初期ルールを確認する
		</button>
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
					: "同梱フォルダーを表示"}
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
					バージョン {setupStatus.observation.extensionVersion}（通信仕様
					{setupStatus.observation.protocolVersion}）から
					{formatDate(setupStatus.observation.lastSeenAt)} に応答がありました。 初期セットアップは完了です。
				</p>
			</div>
		{:else if isIncompatible && setupStatus.observation}
			<div class="response-icon error" aria-hidden="true">!</div>
			<div>
				<p class="section-label">更新が必要です</p>
				<h2>拡張機能のバージョンに互換性がありません</h2>
				<p>
					バージョン {setupStatus.observation.extensionVersion} から応答がありましたが、通信仕様
					{setupStatus.observation.protocolVersion} には対応していません。最新版を導入してください。
				</p>
			</div>
		{:else}
			<div class="response-icon waiting" aria-hidden="true"></div>
			<div>
				<p class="section-label">自動確認中</p>
				<h2>拡張機能からの応答を待っています</h2>
				<p>
					拡張機能を導入した後、Moodleを開いてください。native-hostが応答をSQLiteへ保存すると、この画面は自動的に完了へ切り替わります。
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
</section>

<style>
	.install-panel {
		width: min(100%, 980px);
		margin: 22px auto 0;
		padding: 26px 28px 24px;
		box-sizing: border-box;
		border-radius: 12px;
		background: rgba(255, 255, 255, 0.94);
		box-shadow: 0 28px 52px rgba(96, 105, 151, 0.16);
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

	.chip,
	.local-badge,
	.distribution-badge,
	.step-count {
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
		color: #8085a0;
	}

	.safety-card,
	.distribution-card,
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
		background: #f5f2ff;
		border: 1px solid rgba(124, 104, 246, 0.24);
		color: #525978;
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
		color: #fff;
	}

	.distribution-card {
		padding: 18px 20px;
		background: linear-gradient(180deg, #f7f5ff 0%, #f0effb 100%);
		border: 1px solid rgba(124, 104, 246, 0.22);
		color: #525978;
	}

	.distribution-badge {
		padding: 6px 10px;
		background: #edeaff;
		color: #6256ca;
		font-size: 0.68rem;
		white-space: nowrap;
	}

	.distribution-badge.store {
		background: #edf8f1;
		color: #2e6b43;
	}

	.guide-card {
		padding: 20px;
		background: linear-gradient(180deg, #f9f9ff 0%, #f2f3fb 100%);
		border: 1px solid rgba(203, 207, 226, 0.8);
	}

	.section-label {
		margin-bottom: 6px;
		font-size: 0.7rem;
		font-weight: 700;
		color: #7d83a2;
		text-transform: uppercase;
	}

	.step-count {
		padding: 5px 9px;
		background: rgba(124, 104, 246, 0.09);
		color: #6657d5;
		font-size: 0.68rem;
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
		background: rgba(255, 255, 255, 0.84);
		border: 1px solid rgba(216, 219, 234, 0.92);
	}

	.guide-index {
		width: 22px;
		height: 22px;
		display: grid;
		place-items: center;
		flex: 0 0 auto;
		border-radius: 999px;
		background: var(--fuzzy-color-primary);
		color: #fff;
		font-size: 0.7rem;
		font-weight: 700;
	}

	.guide-list strong {
		font-size: 0.8rem;
		color: #444a6a;
	}

	.guide-list p {
		margin: 5px 0 0;
		font-size: 0.75rem;
		line-height: 1.65;
		color: #737995;
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
		outline: 3px solid rgba(109, 92, 246, 0.3);
		outline-offset: 2px;
	}

	.text-button {
		padding: 9px 4px;
		background: transparent;
		color: #6256ca;
		font-size: 0.76rem;
		font-weight: 700;
	}

	.primary-button,
	.refresh-button {
		padding: 12px 15px;
		font-weight: 700;
	}

	.primary-button {
		background: linear-gradient(180deg, #7f6cff 0%, #6958f5 100%);
		color: #fff;
		box-shadow: 0 12px 24px rgba(109, 92, 246, 0.24);
	}

	.response-card {
		justify-content: flex-start;
		padding: 18px 20px;
		background: #f5f6fb;
		border: 1px solid rgba(203, 207, 226, 0.82);
		color: #525978;
	}

	.response-card.complete {
		background: #edf8f1;
		border-color: #b9e2c7;
		color: #2e6b43;
	}

	.response-card.error {
		background: #fff2f0;
		border-color: #f2c5bd;
		color: #ab3e2d;
	}

	.response-icon.complete {
		background: #4d9c67;
		color: #fff;
	}

	.response-icon.error {
		background: #ab3e2d;
		color: #fff;
	}

	.response-icon.waiting {
		width: 20px;
		height: 20px;
		border: 3px solid rgba(109, 92, 246, 0.2);
		border-top-color: var(--fuzzy-color-primary);
		animation: spin 0.8s linear infinite;
	}

	.refresh-button {
		margin-top: 12px;
		background: #edeaff;
		color: #6256ca;
		font-size: 0.76rem;
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
