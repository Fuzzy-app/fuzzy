<script lang="ts">
	type FolderPattern = {
		id: string;
		title: string;
		description: string;
		exampleTitle: string;
		exampleLines: string[];
		recommended?: boolean;
		selected?: boolean;
	};

	const sideItems = ["保存フォルダ", "フォルダの作り方", "データベース登録"];

	const progressItems = [
		{ label: "フォルダの保存", state: "done" },
		{ label: "階層ルール", state: "current" },
		{ label: "完了", state: "upcoming" },
	];

	const patterns: FolderPattern[] = [
		{
			id: "pattern-course-session",
			title: "年 / 学期 / 科目",
			description:
				"最も多い保存形式をもとに、回ごとの資料を科目単位で整理します",
			exampleTitle: "2025",
			exampleLines: ["春学期", "情報アーキテクチャ"],
			selected: true,
		},
		{
			id: "pattern-simple",
			title: "科目だけ（シンプル）",
			description: "科目別に統一し、授業フォルダの中へまとめる形です",
			exampleTitle: "情報アーキテクチャ",
			exampleLines: ["データベース", "離散数学"],
		},
		{
			id: "pattern-grade-course",
			title: "科目 / 回（おすすめ・標準）",
			description: "回ごとに区切ってテンポよく資料を追える構成です",
			exampleTitle: "情報アーキテクチャ",
			exampleLines: ["第1回", "第2回", "第3回"],
			recommended: true,
		},
	];
</script>

<svelte:head>
	<meta
		name="description"
		content="Fuzzy の初期セットアップ画面。保存パターンの候補を比較しながら、フォルダ構成を選べます。"
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
			<p class="sidebar-label">セットアップ中: ドキュメントを整理します</p>
			<nav aria-label="セットアップの項目">
				<ul class="side-list">
					{#each sideItems as item, index}
						<li class:active={index === 1}>
							<span class="side-index">{index + 1}</span>
							<span>{item}</span>
						</li>
					{/each}
				</ul>
			</nav>
		</aside>

		<section class="content">
			<div class="progress" aria-label="進捗">
				{#each progressItems as item, index}
					<div class="progress-item">
						<div class="progress-dot {item.state}">
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

			<section class="chooser">
				<p class="chip">STEP 2/3</p>
				<h1>フォルダの作り方を選ぶ</h1>
				<p class="intro">
					検出された保存傾向をもとに Fuzzy
					が候補を並べています。あとから変更できるので、
					今の運用にもっとも近い形を選んでください。
				</p>

				<div class="pattern-list">
					{#each patterns as pattern}
						<article class:selected={pattern.selected} class="pattern-card">
							<div class="pattern-main">
								<div class="pattern-title-row">
									<h2>{pattern.title}</h2>
									{#if pattern.recommended}
										<span class="badge">おすすめ</span>
									{/if}
								</div>
								<p>{pattern.description}</p>
							</div>

							<div class="example-box" aria-label={`${pattern.title} の例`}>
								<p>{pattern.exampleTitle}</p>
								<ul>
									{#each pattern.exampleLines as line}
										<li>{line}</li>
									{/each}
								</ul>
							</div>
						</article>
					{/each}
				</div>

				<div class="helper-row">
					<div class="helper-note">
						<span class="helper-icon">i</span>
						<span>もっとも近い候補を選ぶ</span>
					</div>
					<button class="ghost-button" type="button"
						>まだレビューを続ける</button
					>
				</div>

				<button class="primary-button" type="button">この構成で進める</button>
			</section>
		</section>
	</section>
</main>

<style>
	:global(body) {
		margin: 0;
		font-family: "BIZ UDPGothic", "Yu Gothic UI", "Segoe UI", sans-serif;
		background:
			linear-gradient(180deg, #a783ff 0 4px, transparent 4px),
			radial-gradient(
				circle at top,
				rgba(143, 116, 245, 0.16),
				transparent 24%
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
		grid-template-columns: 232px minmax(0, 1fr);
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

	.progress-dot.done {
		background: #36b37e;
		color: #fff;
	}

	.progress-dot.current {
		background: #6d5cf6;
		color: #fff;
		box-shadow: 0 0 0 4px rgba(109, 92, 246, 0.14);
	}

	.chooser {
		width: min(100%, 520px);
		margin: 22px auto 0;
		padding: 26px 28px 18px;
		border-radius: 24px;
		background: rgba(255, 255, 255, 0.94);
		box-shadow: 0 28px 52px rgba(96, 105, 151, 0.16);
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
	p,
	ul {
		margin-top: 0;
	}

	h1 {
		margin-bottom: 8px;
		font-size: 1.7rem;
		letter-spacing: -0.02em;
	}

	.intro {
		margin-bottom: 18px;
		font-size: 0.78rem;
		line-height: 1.65;
		color: #8085a0;
	}

	.pattern-list {
		display: grid;
		gap: 12px;
	}

	.pattern-card {
		padding: 16px;
		display: grid;
		grid-template-columns: minmax(0, 1fr) 128px;
		gap: 14px;
		align-items: center;
		border-radius: 16px;
		border: 1px solid rgba(203, 207, 226, 0.76);
		background: #fff;
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
		margin-bottom: 6px;
	}

	.pattern-title-row h2 {
		margin-bottom: 0;
		font-size: 0.96rem;
	}

	.pattern-main p {
		margin-bottom: 0;
		font-size: 0.72rem;
		line-height: 1.6;
		color: #7b809d;
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
		padding: 10px 12px;
		border-radius: 12px;
		background: #f4f5fb;
		color: #666d8f;
		font-size: 0.72rem;
	}

	.example-box p {
		margin-bottom: 6px;
		font-weight: 700;
		color: #555d82;
	}

	.example-box ul {
		margin: 0;
		padding-left: 1rem;
		line-height: 1.5;
	}

	.helper-row {
		margin-top: 14px;
		padding: 12px 14px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		border-radius: 14px;
		background: linear-gradient(180deg, #fff7d7 0%, #ffedaa 100%);
	}

	.helper-note {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.74rem;
		font-weight: 700;
		color: #8f6a00;
	}

	.helper-icon {
		width: 18px;
		height: 18px;
		display: grid;
		place-items: center;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.72);
	}

	.ghost-button,
	.primary-button {
		border: none;
		font: inherit;
		cursor: pointer;
	}

	.ghost-button {
		padding: 8px 10px;
		border-radius: 10px;
		background: rgba(255, 255, 255, 0.65);
		color: #d08400;
		font-size: 0.72rem;
		font-weight: 700;
	}

	.primary-button {
		width: 100%;
		margin-top: 12px;
		padding: 13px 16px;
		border-radius: 12px;
		background: linear-gradient(180deg, #7f6cff 0%, #6958f5 100%);
		color: #fff;
		font-weight: 700;
		box-shadow: 0 14px 28px rgba(109, 92, 246, 0.28);
	}

	@media (max-width: 920px) {
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

		.chooser {
			width: 100%;
		}
	}

	@media (max-width: 640px) {
		.window {
			padding: 8px;
		}

		.content {
			padding: 16px;
		}

		.chooser {
			padding: 20px 16px 16px;
		}

		.pattern-card {
			grid-template-columns: 1fr;
		}

		.helper-row {
			flex-direction: column;
			align-items: stretch;
		}

		.ghost-button,
		.primary-button {
			width: 100%;
		}

		.brand-copy {
			flex-direction: column;
			align-items: flex-start;
			gap: 0;
		}

		.side-list {
			grid-template-columns: 1fr;
		}
	}
</style>
