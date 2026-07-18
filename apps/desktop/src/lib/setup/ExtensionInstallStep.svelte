<script lang="ts">
	import { onMount } from "svelte";
	import {
		ExtensionInstallError,
		createDestinationOpenedStateInput,
		createInitialExtensionInstallState,
		detectSupportedBrowser,
		getExtensionInstallChannelForState,
		getExtensionInstallDestination,
		getExtensionInstallStateClient,
		getPreferredExtensionInstallChannel,
		getSupportedBrowserOption,
		isExtensionInstallStateForDestination,
		openExtensionInstallDestinationClient,
		saveExtensionInstallStateClient,
		supportedBrowserOptions,
	} from "./extension-install";
	import type {
		BrowserChoice,
		ExtensionInstallChannel,
		ExtensionInstallState,
		ExtensionInstallStatus,
	} from "./extension-install";

	export let onBack: () => void = () => undefined;

	let detectedBrowser: BrowserChoice = "unsupported";
	let selectedBrowser: BrowserChoice = "unsupported";
	let selectedChannel: ExtensionInstallChannel = "bundled";
	let installState: ExtensionInstallState =
		createInitialExtensionInstallState("unsupported");
	let confirmationChecked = false;
	let isLoading = true;
	let isOpening = false;
	let isSaving = false;
	let errorMessage: string | null = null;
	let successMessage: string | null = null;

	onMount(async () => {
		detectedBrowser = detectSupportedBrowser(navigator.userAgent);

		try {
			installState = await getExtensionInstallStateClient(detectedBrowser);
			selectedBrowser = installState.browserId;
			selectedChannel = getExtensionInstallChannelForState(installState);

			confirmationChecked = installState.status === "confirmed";
		} catch {
			errorMessage = "拡張機能の導入状態を読み込めませんでした。";
		} finally {
			isLoading = false;
		}
	});

	function formatDate(value: string | undefined): string {
		if (!value || Number.isNaN(Date.parse(value))) {
			return "日時未記録";
		}

		return new Intl.DateTimeFormat("ja-JP", {
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		}).format(new Date(value));
	}

	function getErrorMessage(error: unknown): string {
		if (error instanceof ExtensionInstallError) {
			return error.message;
		}

		return "導入先を開けませんでした。時間をおいて再試行してください。";
	}

	async function persistStatus(
		status: ExtensionInstallStatus,
		options: { lastOpenedAt?: string; completedAt?: string } = {},
	): Promise<void> {
		installState = await saveExtensionInstallStateClient({
			browserId: selectedBrowser,
			channel: selectedChannel,
			status,
			...options,
		});
	}

	async function handleBrowserChange(): Promise<void> {
		errorMessage = null;
		successMessage = null;
		confirmationChecked = false;
		selectedChannel = getPreferredExtensionInstallChannel(selectedBrowser);

		try {
			await persistStatus("not-started");
		} catch {
			errorMessage = "選択したブラウザを保存できませんでした。";
		}
	}

	async function handleOpenDestination(): Promise<void> {
		isOpening = true;
		errorMessage = null;
		successMessage = null;

		try {
			const result = await openExtensionInstallDestinationClient(
				selectedBrowser,
				selectedChannel,
			);
			const openedAt = new Date().toISOString();

			installState = await saveExtensionInstallStateClient(
				createDestinationOpenedStateInput(
					installState,
					selectedBrowser,
					selectedChannel,
					openedAt,
				),
			);
			confirmationChecked = false;
			if (result.mocked) {
				successMessage =
					"ブラウザプレビューでは外部アプリを開かず、導入操作を開始した状態にしました。";
			} else if (result.destination.kind === "bundled") {
				successMessage =
					"同梱された拡張機能フォルダーをエクスプローラーで表示しました。読み込み後、この画面へ戻って確認してください。";
			} else {
				successMessage = `${result.destination.label}を開きました。導入後、この画面へ戻って確認してください。`;
			}
		} catch (error) {
			errorMessage = getErrorMessage(error);
		} finally {
			isOpening = false;
		}
	}

	async function handleConfirm(): Promise<void> {
		if (!confirmationChecked) {
			return;
		}

		isSaving = true;
		errorMessage = null;
		successMessage = null;

		try {
			await persistStatus("confirmed", {
				lastOpenedAt: installState.lastOpenedAt,
				completedAt: new Date().toISOString(),
			});
			successMessage =
				"拡張機能の導入確認を保存しました。初期セットアップは完了です。";
		} catch {
			errorMessage = "導入確認を保存できませんでした。";
		} finally {
			isSaving = false;
		}
	}

	$: detectedBrowserOption = getSupportedBrowserOption(detectedBrowser);
	$: selectedBrowserOption = getSupportedBrowserOption(selectedBrowser);
	$: destination = getExtensionInstallDestination(
		selectedBrowser,
		selectedChannel,
	);
	$: isCurrentDestinationState = isExtensionInstallStateForDestination(
		installState,
		selectedBrowser,
		selectedChannel,
	);
	$: isCompleted =
		isCurrentDestinationState && installState.status === "confirmed";
	$: canConfirm =
		isCurrentDestinationState &&
		(installState.status === "destination-opened" ||
			installState.status === "confirmed" ||
			Boolean(installState.lastOpenedAt));
	$: isBusy = isLoading || isOpening || isSaving;
</script>

<section class="install-panel" aria-labelledby="extension-install-heading">
	<header class="install-header">
		<div>
			<p class="chip">STEP 4 / 4</p>
			<h1 id="extension-install-heading">ブラウザ拡張機能を導入</h1>
			<p class="intro">
				FuzzyをMoodleで使うブラウザを選び、ブラウザが認める手順で拡張機能を導入します。
			</p>
		</div>
		<span class="local-badge">ローカル完結</span>
	</header>

	{#if isLoading}
		<p class="status-banner" role="status">導入状態を読み込んでいます...</p>
	{:else}
		{#if isCompleted}
			<div class="completion-banner" role="status">
				<div class="completion-icon" aria-hidden="true">✓</div>
				<div>
					<strong>拡張機能の導入を確認済みです</strong>
					<p>
						{formatDate(installState.completedAt)}
						に保存しました。必要なら下の手順をもう一度実行できます。
					</p>
				</div>
			</div>
		{/if}

		<section class="safety-card" aria-labelledby="safety-heading">
			<div class="safety-icon" aria-hidden="true">i</div>
			<div>
				<h2 id="safety-heading">導入の確定はブラウザ上で行います</h2>
				<p>
					Fuzzyは拡張機能の同梱フォルダーまたは公式ストアを表示するところまでを案内します。ブラウザポリシーやレジストリを変更せず、学習データも外部送信しません。
				</p>
			</div>
		</section>

		<fieldset class="browser-fieldset">
			<legend>
				<span>使用するブラウザ</span>
				<small>
					{#if detectedBrowserOption}
						起動環境からの候補: {detectedBrowserOption.name}
					{:else}
						起動環境から候補を判定できませんでした
					{/if}
				</small>
			</legend>
			<p class="browser-hint">
				候補はこの画面の表示エンジンから推定しています。Moodleで実際に使うブラウザと異なる場合は、使用するブラウザを選び直してください。
			</p>

			<div class="browser-grid">
				{#each supportedBrowserOptions as browser}
					<label
						class:selected={selectedBrowser === browser.id}
						class="browser-card"
					>
						<input
							type="radio"
							name="browser"
							value={browser.id}
							bind:group={selectedBrowser}
							on:change={handleBrowserChange}
							disabled={isBusy}
						/>
						<span class="browser-mark" aria-hidden="true">
							{browser.id === "chrome" ? "C" : "E"}
						</span>
						<span>
							<strong>{browser.name}</strong>
							<small>{browser.description}</small>
						</span>
					</label>
				{/each}

				<label
					class:selected={selectedBrowser === "unsupported"}
					class="browser-card"
				>
					<input
						type="radio"
						name="browser"
						value="unsupported"
						bind:group={selectedBrowser}
						on:change={handleBrowserChange}
						disabled={isBusy}
					/>
					<span class="browser-mark unsupported" aria-hidden="true">?</span>
					<span>
						<strong>その他のブラウザ</strong>
						<small>現在は導入先を自動で案内できません。</small>
					</span>
				</label>
			</div>
		</fieldset>

		{#if selectedBrowser === "unsupported"}
			<p class="error-banner" role="alert">
				現在はGoogle ChromeとMicrosoft
				Edgeに対応しています。セットアップを完了するには、どちらかを選択してください。
			</p>
		{/if}

		<section class="distribution-card" aria-labelledby="distribution-heading">
			<div>
				<p class="section-label">現在の導入方法</p>
				<h2 id="distribution-heading">{destination.label}</h2>
				<p>
					{#if selectedChannel === "store"}
						公式ストアで公開されたFuzzyを導入します。
					{:else}
						拡張機能はFuzzyアプリに同梱済みです。利用者によるビルドやコマンド操作は必要ありません。
					{/if}
				</p>
			</div>
			<span
				class:store={selectedChannel === "store"}
				class="distribution-badge"
			>
				{selectedChannel === "store" ? "公式配布" : "アプリ同梱"}
			</span>
		</section>

		<section class="guide-card" aria-labelledby="install-guide-heading">
			<div class="guide-heading">
				<div>
					<p class="section-label">
						{selectedChannel === "store"
							? "公式ストアの導入手順"
							: "同梱版の導入手順"}
					</p>
					<h2 id="install-guide-heading">
						{selectedBrowserOption?.name ?? "対応ブラウザ"}へ導入する
					</h2>
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
							<strong>公式ストアを開く</strong>
							<p>
								下のボタンから、選択したブラウザのFuzzy配布ページを開きます。
							</p>
						</div>
					</li>
					<li>
						<span class="guide-index">2</span>
						<div>
							<strong>ブラウザへ追加</strong>
							<p>
								ストア上の追加ボタンを押し、表示される権限を確認して導入します。
							</p>
						</div>
					</li>
				</ol>
			{:else}
				<ol class="guide-list">
					<li>
						<span class="guide-index">1</span>
						<div>
							<strong>同梱フォルダーを表示</strong>
							<p>
								下のボタンを押すと、Fuzzyアプリに同梱された
								<code>chrome-mv3</code> フォルダーをエクスプローラーで確認できます。
							</p>
						</div>
					</li>
					<li>
						<span class="guide-index">2</span>
						<div>
							<strong>拡張機能の管理画面を開く</strong>
							<p>
								{selectedBrowserOption?.name ?? "ブラウザ"}のアドレスバーへ
								<code
									>{selectedBrowserOption?.managementUrl ??
										"拡張機能管理画面"}</code
								>
								を入力し、デベロッパーモードを有効にします。
							</p>
						</div>
					</li>
					<li>
						<span class="guide-index">3</span>
						<div>
							<strong>表示したフォルダーを読み込む</strong>
							<p>
								「パッケージ化されていない拡張機能を読み込む」を選び、エクスプローラーで表示した
								<code>chrome-mv3</code> フォルダーを指定します。
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
				disabled={isBusy}
			>
				初期ルールを確認する
			</button>
			<button
				class="primary-button"
				type="button"
				on:click={handleOpenDestination}
				disabled={!destination.available || isBusy}
				aria-busy={isOpening}
			>
				{isOpening
					? selectedChannel === "store"
						? "公式ストアを開いています..."
						: "同梱フォルダーを表示しています..."
					: errorMessage
						? selectedChannel === "store"
							? "公式ストアを再度開く"
							: "同梱フォルダーを再度表示"
						: selectedChannel === "store"
							? "公式ストアでFuzzyを開く"
							: "同梱フォルダーを表示"}
			</button>
		</div>

		{#if canConfirm}
			<section class="confirmation-card" aria-labelledby="confirmation-heading">
				<div>
					<p class="section-label">導入後の確認</p>
					<h2 id="confirmation-heading">
						Fuzzyがブラウザに表示されることを確認
					</h2>
					<p>
						拡張機能の管理画面でFuzzyが有効になっていることを確認してから完了してください。
					</p>
				</div>
				<label class="confirmation-check">
					<input
						type="checkbox"
						bind:checked={confirmationChecked}
						disabled={isBusy}
					/>
					<span>ブラウザにFuzzyが表示されることを確認しました</span>
				</label>
				<button
					class="confirm-button"
					type="button"
					on:click={handleConfirm}
					disabled={!confirmationChecked || isBusy}
					aria-busy={isSaving}
				>
					{isSaving ? "保存中..." : "確認してセットアップを完了"}
				</button>
			</section>
		{/if}
	{/if}
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
	.install-actions {
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
		max-width: 660px;
		margin-bottom: 0;
		font-size: 0.82rem;
		line-height: 1.7;
		color: #8085a0;
	}

	.status-banner,
	.error-banner,
	.success-banner,
	.completion-banner,
	.safety-card,
	.distribution-card,
	.guide-card,
	.confirmation-card {
		margin-top: 20px;
		border-radius: 8px;
	}

	.status-banner,
	.error-banner,
	.success-banner {
		padding: 14px 16px;
		font-size: 0.8rem;
	}

	.status-banner {
		background: #f5f6fb;
		color: #737995;
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

	.completion-banner,
	.safety-card {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 16px 18px;
	}

	.completion-banner {
		background: linear-gradient(180deg, #edf8f1 0%, #e4f4ea 100%);
		border: 1px solid #b9e2c7;
		color: #2e6b43;
	}

	.completion-banner p,
	.safety-card p,
	.confirmation-card p {
		margin: 5px 0 0;
		font-size: 0.78rem;
		line-height: 1.65;
	}

	.completion-icon,
	.safety-icon {
		width: 24px;
		height: 24px;
		display: grid;
		place-items: center;
		flex: 0 0 auto;
		border-radius: 999px;
		font-size: 0.75rem;
		font-weight: 700;
	}

	.completion-icon {
		background: #4d9c67;
		color: #fff;
	}

	.safety-card {
		background: #f5f2ff;
		border: 1px solid rgba(124, 104, 246, 0.24);
		color: #525978;
	}

	.safety-icon {
		background: var(--fuzzy-color-primary);
		color: #fff;
	}

	.safety-card h2 {
		color: #4d477d;
	}

	.browser-fieldset {
		margin: 24px 0 0;
		padding: 0;
		border: none;
	}

	.browser-fieldset legend {
		width: 100%;
		padding: 0;
		font-size: 0.9rem;
		font-weight: 700;
		color: #444a6a;
	}

	.browser-fieldset legend {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}

	.browser-fieldset legend small {
		font-size: 0.7rem;
		font-weight: 400;
		color: #7d83a2;
	}

	.browser-hint {
		margin: 7px 0 0;
		font-size: 0.7rem;
		line-height: 1.55;
		color: #7d83a2;
	}

	.browser-grid {
		margin-top: 12px;
		display: grid;
		gap: 12px;
	}

	.browser-grid {
		grid-template-columns: repeat(3, minmax(0, 1fr));
	}

	.browser-card {
		position: relative;
		display: flex;
		align-items: flex-start;
		gap: 11px;
		padding: 15px;
		border-radius: 8px;
		border: 1px solid rgba(203, 207, 226, 0.88);
		background: #fff;
		color: #454c6c;
		cursor: pointer;
		transition:
			border-color 0.18s ease,
			box-shadow 0.18s ease;
	}

	.browser-card.selected {
		border-color: #7c68f6;
		box-shadow: 0 0 0 3px rgba(124, 104, 246, 0.12);
	}

	.browser-card:focus-within,
	button:focus-visible,
	.confirmation-check:focus-within {
		outline: 3px solid rgba(109, 92, 246, 0.3);
		outline-offset: 2px;
	}

	.browser-card input {
		margin-top: 3px;
		accent-color: var(--fuzzy-color-primary);
	}

	.browser-mark {
		width: 28px;
		height: 28px;
		display: grid;
		place-items: center;
		flex: 0 0 auto;
		border-radius: 8px;
		background: linear-gradient(180deg, #8d7bff 0%, #6b5bf6 100%);
		color: #fff;
		font-size: 0.78rem;
		font-weight: 700;
	}

	.browser-mark.unsupported {
		background: #a7acc0;
	}

	.browser-card strong {
		display: block;
		font-size: 0.82rem;
	}

	.browser-card small {
		display: block;
		margin-top: 4px;
		font-size: 0.7rem;
		line-height: 1.5;
		color: #7b809d;
	}

	.distribution-card {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		padding: 18px 20px;
		background: linear-gradient(180deg, #f7f5ff 0%, #f0effb 100%);
		border: 1px solid rgba(124, 104, 246, 0.22);
		color: #525978;
	}

	.distribution-card h2 {
		margin-bottom: 0;
		color: #4d477d;
	}

	.distribution-card p:not(.section-label) {
		margin: 7px 0 0;
		font-size: 0.76rem;
		line-height: 1.65;
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

	code {
		padding: 2px 5px;
		border-radius: 4px;
		background: #eceef7;
		color: #4b5170;
		font-family: "Cascadia Code", Consolas, monospace;
		font-size: 0.7rem;
		word-break: break-all;
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

	.text-button {
		padding: 9px 4px;
		background: transparent;
		color: #6256ca;
		font-size: 0.76rem;
		font-weight: 700;
	}

	.primary-button,
	.confirm-button {
		padding: 12px 15px;
		font-weight: 700;
	}

	.primary-button,
	.confirm-button {
		background: linear-gradient(180deg, #7f6cff 0%, #6958f5 100%);
		color: #fff;
		box-shadow: 0 12px 24px rgba(109, 92, 246, 0.24);
	}

	.confirmation-card {
		padding: 18px 20px;
		background: linear-gradient(180deg, #fff8dd 0%, #fff0bb 100%);
		border: 1px solid rgba(225, 193, 92, 0.52);
		color: #6f5600;
	}

	.confirmation-check {
		margin-top: 14px;
		display: flex;
		align-items: flex-start;
		gap: 9px;
		padding: 11px 12px;
		border-radius: 7px;
		background: rgba(255, 255, 255, 0.7);
		font-size: 0.78rem;
		font-weight: 700;
	}

	.confirmation-check input {
		margin-top: 2px;
		accent-color: var(--fuzzy-color-primary);
	}

	.confirm-button {
		margin-top: 14px;
	}

	@media (max-width: 880px) {
		.browser-grid {
			grid-template-columns: 1fr;
		}
	}

	@media (max-width: 720px) {
		.install-panel {
			padding: 20px 16px 18px;
		}

		.install-header,
		.install-actions,
		.distribution-card,
		.browser-fieldset legend {
			flex-direction: column;
			align-items: stretch;
		}

		.install-actions .primary-button,
		.confirm-button {
			width: 100%;
		}
	}
</style>
