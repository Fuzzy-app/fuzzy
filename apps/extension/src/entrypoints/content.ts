import {
	createApiClient,
	type FuzzyApiClient,
	type SearchResult,
} from "@fuzzy/shared";

const ROOT_ID = "fuzzy-shell-root";
const STYLE_ID = "fuzzy-shell-style";
const BUTTON_ID = "fuzzy-shell-nav-button";
const PAGE_ID = "fuzzy-shell-page";
const STASH_ID = "fuzzy-shell-stash";

type ConnectionMode = FuzzyApiClient["mode"] | "checking";
type ScreenId = "dashboard" | "search" | "deadlines" | "courses" | "organize";

interface SearchState {
	query: string;
	results: SearchResult[];
	selectedResultId: number | null;
	loading: boolean;
	error: string | null;
}

const menuItems: {
	id: ScreenId;
	label: string;
	enabled: boolean;
	description: string;
}[] = [
	{ id: "dashboard", label: "ダッシュボード", enabled: false, description: "issue57 で実装" },
	{ id: "search", label: "横断検索", enabled: true, description: "issue54" },
	{ id: "deadlines", label: "締切ハブ", enabled: false, description: "issue55 で有効化" },
	{ id: "courses", label: "コース一覧", enabled: false, description: "今後の画面" },
	{ id: "organize", label: "重複の整理", enabled: false, description: "今後の画面" },
];

export default defineContentScript({
	matches: ["*://*.wakayama-u.ac.jp/*"],
	main() {
		void mountFuzzyShell();
	},
});

async function mountFuzzyShell(): Promise<void> {
	if (document.getElementById(ROOT_ID)) return;

	const navHost = findNavHost();
	const mainHost = findMainHost();
	if (!navHost || !mainHost) {
		console.warn("[fuzzy] ナビゲーションまたは本文領域が見つかりませんでした");
		return;
	}

	ensureStyle();

	const root = document.createElement("div");
	root.id = ROOT_ID;
	root.innerHTML = `
		<button id="${BUTTON_ID}" type="button" class="fuzzy-nav-button" aria-pressed="false">
			<span class="fuzzy-nav-mark">F</span>
			<span>Fuzzy</span>
		</button>
	`;
	navHost.append(root);

	const navButton = root.querySelector<HTMLButtonElement>(`#${BUTTON_ID}`);
	if (!navButton) return;

	const stash = document.createElement("div");
	stash.id = STASH_ID;
	stash.hidden = true;
	mainHost.after(stash);

	const apiPromise = createApiClient();
	let page: HTMLElement | null = null;
	let isOpen = false;
	let activeScreen: ScreenId = "search";
	let mode: ConnectionMode = "checking";
	const searchState: SearchState = {
		query: "正規化",
		results: [],
		selectedResultId: null,
		loading: false,
		error: null,
	};

	const moveMainContentToStash = () => {
		while (mainHost.firstChild) {
			stash.append(mainHost.firstChild);
		}
	};

	const restoreMainContent = () => {
		while (stash.firstChild) {
			mainHost.append(stash.firstChild);
		}
	};

	const setModeLabel = (label: HTMLElement, nextMode: ConnectionMode) => {
		mode = nextMode;
		label.dataset.mode = nextMode;
		label.textContent =
			nextMode === "native"
				? "完全ローカル・実データ接続"
				: nextMode === "mock"
					? "完全ローカル・サンプル表示"
					: "接続確認中";
	};

	const getSearchSelection = () =>
		searchState.results.find((result) => result.fileId === searchState.selectedResultId) ?? null;

	const runSearch = async () => {
		const query = searchState.query.trim();
		if (!query) {
			searchState.error = "検索したいワードを入力してください。";
			searchState.results = [];
			searchState.selectedResultId = null;
			renderScreen();
			return;
		}

		searchState.loading = true;
		searchState.error = null;
		renderScreen();

		try {
			const api = await apiPromise;
			searchState.results = await api.search(query);
			searchState.selectedResultId = searchState.results[0]?.fileId ?? null;
			setTopMode(api.mode);
		} catch (error) {
			searchState.error = error instanceof Error ? error.message : String(error);
			searchState.results = [];
			searchState.selectedResultId = null;
		} finally {
			searchState.loading = false;
			renderScreen();
		}
	};

	const closeShell = () => {
		if (!isOpen) return;
		isOpen = false;
		navButton.classList.remove("is-active");
		navButton.setAttribute("aria-pressed", "false");
		page?.remove();
		restoreMainContent();
	};

	const setTopMode = (nextMode: ConnectionMode) => {
		mode = nextMode;
		const badge = page?.querySelector<HTMLElement>(".fuzzy-top-status");
		if (badge) setModeLabel(badge, nextMode);
	};

	const renderSidebarState = () => {
		page?.querySelectorAll<HTMLButtonElement>(".fuzzy-side-link").forEach((button) => {
			const isActive = button.dataset.screen === activeScreen;
			button.classList.toggle("is-active", isActive);
			button.setAttribute("aria-current", isActive ? "page" : "false");
		});
	};

	const renderSearchScreen = (host: HTMLElement) => {
		const selected = getSearchSelection();
		host.innerHTML = `
			<header class="fuzzy-screen-header">
				<div>
					<p class="fuzzy-screen-kicker">横断検索</p>
					<h1>どのファイルに載っているか</h1>
				</div>
			</header>
			<section class="fuzzy-search-panel">
				<div class="fuzzy-search-tabs">
					<button type="button" class="fuzzy-chip is-active">キーワード</button>
					<button type="button" class="fuzzy-chip" disabled>講義で検索</button>
				</div>
				<form class="fuzzy-search-form">
					<div class="fuzzy-search-input-wrap">
						<span class="fuzzy-search-dot"></span>
						<input id="fuzzy-search-input" type="search" value="${escapeHtml(searchState.query)}" placeholder="調べたい単語を入力" />
					</div>
					<button type="submit" class="fuzzy-primary-button">${searchState.loading ? "検索中…" : "検索"}</button>
				</form>
				<div class="fuzzy-search-meta">
					<p>${searchState.query ? `「${escapeHtml(searchState.query)}」に一致: ${searchState.results.length}ファイル` : "キーワードを入力してください"}</p>
					<label class="fuzzy-toggle">
						<span>AIで要約（任意・実験的）</span>
						<input type="checkbox" disabled />
						<span class="fuzzy-toggle-ui"></span>
					</label>
				</div>
			</section>
			<section class="fuzzy-search-layout">
				<div class="fuzzy-search-results">
					${
						searchState.error
							? `<p class="fuzzy-error">検索に失敗しました: ${escapeHtml(searchState.error)}</p>`
							: searchState.loading
								? '<p class="fuzzy-loading">検索中…</p>'
								: searchState.results.length === 0
									? '<section class="fuzzy-empty"><h2>まだ結果がありません</h2><p>サンプルでは「正規化」で結果が表示されます。</p></section>'
									: `
										<p class="fuzzy-section-label">該当箇所順（関連が高い順）</p>
										<div class="fuzzy-result-list">
											${searchState.results
												.map(
													(result) => `
													<button type="button" class="fuzzy-result-row ${result.fileId === searchState.selectedResultId ? "is-selected" : ""}" data-file-id="${result.fileId}">
														<div class="fuzzy-result-kind ${fileKindClass(result.fileName)}">${fileKindLabel(result.fileName)}</div>
														<div class="fuzzy-result-main">
															<p class="fuzzy-result-title">${escapeHtml(result.fileName)}</p>
															<p class="fuzzy-result-sub">${escapeHtml(result.courseName ?? "授業名なし")}</p>
														</div>
														<p class="fuzzy-result-snippet">${escapeHtml(result.snippet)}</p>
														<div class="fuzzy-result-side">
															<p>${result.page === null ? "—" : `p.${result.page}`}</p>
															<span>${result.page === null ? "ファイルを開く" : "ページへ"}</span>
														</div>
													</button>
												`,
												)
												.join("")}
										</div>
									`
					}
				</div>
				<div class="fuzzy-search-note">
					${
						selected
							? `
								<p class="fuzzy-section-label">選択中の候補</p>
								<h2>${escapeHtml(selected.fileName)}</h2>
								<p class="fuzzy-note-copy">${selected.page === null ? "該当箇所を見つけました。ページ情報は未登録です。" : `${selected.page}ページ付近に該当箇所があります。`}</p>
								<dl class="fuzzy-note-grid">
									<div><dt>授業</dt><dd>${escapeHtml(selected.courseName ?? "未設定")}</dd></div>
									<div><dt>ページ</dt><dd>${selected.page === null ? "ページ情報なし" : `${selected.page}ページ`}</dd></div>
									<div><dt>一致度</dt><dd>${Math.round(selected.score * 100)}%</dd></div>
								</dl>
							`
							: `
								<p class="fuzzy-section-label">検索のメモ</p>
								<h2>資料の所在を見つける</h2>
								<p class="fuzzy-note-copy">スニペットは検索語の前後だけを短く抜き出した本文です。まずは「正規化」で確認できます。</p>
							`
					}
				</div>
			</section>
		`;

		host.querySelector<HTMLFormElement>(".fuzzy-search-form")?.addEventListener("submit", (event) => {
			event.preventDefault();
			const input = host.querySelector<HTMLInputElement>("#fuzzy-search-input");
			searchState.query = input?.value ?? "";
			void runSearch();
		});

		host.querySelectorAll<HTMLButtonElement>(".fuzzy-result-row").forEach((button) => {
			button.addEventListener("click", () => {
				searchState.selectedResultId = Number(button.dataset.fileId);
				renderScreen();
			});
		});
	};

	const renderPlaceholderScreen = (host: HTMLElement, title: string, copy: string) => {
		host.innerHTML = `
			<header class="fuzzy-screen-header">
				<div>
					<p class="fuzzy-screen-kicker">準備中</p>
					<h1>${escapeHtml(title)}</h1>
				</div>
			</header>
			<section class="fuzzy-placeholder">
				<p>${escapeHtml(copy)}</p>
			</section>
		`;
	};

	const renderScreen = () => {
		if (!page) return;
		renderSidebarState();
		const host = page.querySelector<HTMLElement>(".fuzzy-main");
		const badge = page.querySelector<HTMLElement>(".fuzzy-top-status");
		if (!host || !badge) return;
		setModeLabel(badge, mode);

		switch (activeScreen) {
			case "search":
				renderSearchScreen(host);
				break;
			case "dashboard":
				renderPlaceholderScreen(host, "ダッシュボード", "issue57 で実装する予定です。");
				break;
			case "deadlines":
				renderPlaceholderScreen(host, "締切ハブ", "issue55 でこのメニューが有効になり、課題一覧と提出状況の切り替えが追加されます。");
				break;
			case "courses":
				renderPlaceholderScreen(host, "コース一覧", "今後の画面としてここへ統合していきます。");
				break;
			case "organize":
				renderPlaceholderScreen(host, "重複の整理", "保存済み資料の整理UIをここへ追加する予定です。");
				break;
		}
	};

	const buildPage = () => {
		if (page) return page;

		page = document.createElement("section");
		page.id = PAGE_ID;
		page.className = "fuzzy-shell";
		page.innerHTML = `
			<div class="fuzzy-sidebar">
				<div class="fuzzy-brand">
					<span class="fuzzy-brand-mark">F</span>
					<span>Fuzzy</span>
				</div>
				<nav class="fuzzy-side-nav" aria-label="Fuzzy menu">
					${menuItems
						.map(
							(item) => `
								<button
									type="button"
									class="fuzzy-side-link ${item.enabled ? "" : "is-disabled"}"
									data-screen="${item.id}"
									${item.enabled ? "" : "disabled"}
									title="${escapeHtml(item.description)}"
								>
									<span class="fuzzy-side-dot"></span>
									<span>${escapeHtml(item.label)}</span>
								</button>
							`,
						)
						.join("")}
				</nav>
				<div class="fuzzy-sidebar-footer">
					<p>検索を実装中</p>
					<span>issue54 / mock search</span>
				</div>
			</div>
			<div class="fuzzy-content">
				<header class="fuzzy-topbar">
					<p class="fuzzy-top-status" data-mode="checking">接続確認中</p>
					<button type="button" class="fuzzy-close-button">Moodleに戻る</button>
				</header>
				<main class="fuzzy-main"></main>
			</div>
		`;

		page.querySelector<HTMLButtonElement>(".fuzzy-close-button")?.addEventListener("click", () => {
			closeShell();
		});

		page.querySelectorAll<HTMLButtonElement>(".fuzzy-side-link").forEach((button) => {
			button.addEventListener("click", () => {
				activeScreen = button.dataset.screen as ScreenId;
				if (activeScreen === "search" && searchState.results.length === 0 && !searchState.loading) {
					void runSearch();
				}
				renderScreen();
			});
		});

		renderScreen();
		return page;
	};

	const openShell = async () => {
		if (isOpen) return;
		isOpen = true;
		navButton.classList.add("is-active");
		navButton.setAttribute("aria-pressed", "true");
		moveMainContentToStash();
		mainHost.append(buildPage());

		try {
			const api = await apiPromise;
			setTopMode(api.mode);
		} catch {
			setTopMode("checking");
		}

		if (activeScreen === "search" && searchState.results.length === 0 && !searchState.loading) {
			void runSearch();
		}
	};

	navButton.addEventListener("click", () => {
		if (isOpen) {
			closeShell();
			return;
		}
		void openShell();
	});

	navHost.addEventListener("click", (event) => {
		const target = event.target;
		if (!(target instanceof Element)) return;
		const otherNavItem = target.closest("a, button");
		if (!otherNavItem || otherNavItem === navButton) return;
		closeShell();
	});
}

function fileKindLabel(fileName: string): string {
	const lower = fileName.toLowerCase();
	if (lower.endsWith(".pdf")) return "PDF";
	if (lower.endsWith(".ppt") || lower.endsWith(".pptx")) return "PPTX";
	if (lower.endsWith(".doc") || lower.endsWith(".docx")) return "DOCX";
	return "FILE";
}

function fileKindClass(fileName: string): string {
	const lower = fileName.toLowerCase();
	if (lower.endsWith(".pdf")) return "is-pdf";
	if (lower.endsWith(".ppt") || lower.endsWith(".pptx")) return "is-ppt";
	if (lower.endsWith(".doc") || lower.endsWith(".docx")) return "is-doc";
	return "";
}

function findNavHost(): HTMLElement | null {
	const selectors = [
		".primary-navigation .navigation .nav.more-nav",
		".primary-navigation .moremenu",
		"nav .nav.more-nav",
		"header nav ul",
	];

	for (const selector of selectors) {
		const target = document.querySelector<HTMLElement>(selector);
		if (target) return target;
	}

	return null;
}

function findMainHost(): HTMLElement | null {
	const selectors = [
		"#region-main",
		"main[role='main']",
		"#page-content #region-main-box",
		"#page-content",
		".main-inner",
	];

	for (const selector of selectors) {
		const target = document.querySelector<HTMLElement>(selector);
		if (target) return target;
	}

	return null;
}

function ensureStyle(): void {
	if (document.getElementById(STYLE_ID)) return;

	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
		#${ROOT_ID} {
			display: inline-flex;
			align-items: stretch;
			margin-left: 8px;
		}

		.fuzzy-nav-button {
			display: inline-flex;
			align-items: center;
			gap: 10px;
			border: 0;
			border-bottom: 3px solid transparent;
			padding: 12px 16px 10px;
			background: transparent;
			color: #151515;
			font-family: "Yu Gothic UI", "Hiragino Sans", "Meiryo", sans-serif;
			font-size: 0.95rem;
			font-weight: 700;
			cursor: pointer;
		}

		.fuzzy-nav-button:hover,
		.fuzzy-nav-button.is-active {
			border-bottom-color: #6c63ff;
		}

		.fuzzy-nav-mark {
			display: inline-grid;
			place-items: center;
			width: 28px;
			height: 28px;
			border-radius: 10px;
			background: #6c63ff;
			color: #ffffff;
			font-weight: 900;
			line-height: 1;
		}

		#${PAGE_ID} {
			display: grid;
			grid-template-columns: 148px minmax(0, 1fr);
			min-height: 720px;
			border-radius: 18px;
			overflow: hidden;
			background: #f6f7ff;
			box-shadow: 0 18px 60px rgba(31, 38, 92, 0.16);
			color: #151515;
			font-family: "Yu Gothic UI", "Hiragino Sans", "Meiryo", sans-serif;
		}

		.fuzzy-sidebar {
			display: grid;
			grid-template-rows: auto 1fr auto;
			gap: 24px;
			padding: 18px 12px;
			background: #20243a;
			color: #f4f6ff;
		}

		.fuzzy-brand {
			display: flex;
			align-items: center;
			gap: 10px;
			font-size: 1rem;
			font-weight: 800;
		}

		.fuzzy-brand-mark {
			display: inline-grid;
			place-items: center;
			width: 24px;
			height: 24px;
			border-radius: 8px;
			background: #5c5cff;
			font-size: 0.85rem;
			font-weight: 900;
		}

		.fuzzy-side-nav {
			display: grid;
			align-content: start;
			gap: 8px;
		}

		.fuzzy-side-link {
			display: flex;
			align-items: center;
			gap: 10px;
			border: 0;
			border-radius: 10px;
			padding: 12px 10px;
			background: transparent;
			color: #c6c9de;
			font: inherit;
			font-size: 0.84rem;
			font-weight: 700;
			text-align: left;
			cursor: pointer;
		}

		.fuzzy-side-link.is-active {
			background: #353b67;
			color: #ffffff;
		}

		.fuzzy-side-link.is-disabled {
			cursor: not-allowed;
			opacity: 0.52;
		}

		.fuzzy-side-dot {
			width: 12px;
			height: 12px;
			border-radius: 4px;
			background: #6d7295;
		}

		.fuzzy-side-link.is-active .fuzzy-side-dot {
			background: #756cff;
		}

		.fuzzy-sidebar-footer {
			border-radius: 10px;
			padding: 12px 10px;
			background: rgba(255, 255, 255, 0.08);
			font-size: 0.72rem;
		}

		.fuzzy-sidebar-footer p,
		.fuzzy-sidebar-footer span {
			margin: 0;
			display: block;
		}

		.fuzzy-sidebar-footer p {
			margin-bottom: 4px;
			color: #a9f2b9;
			font-weight: 800;
		}

		.fuzzy-content {
			padding: 18px 20px 22px;
		}

		.fuzzy-topbar {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 16px;
			margin-bottom: 10px;
		}

		.fuzzy-top-status {
			margin: 0;
			border-radius: 999px;
			padding: 6px 12px;
			background: #dcf9e8;
			color: #14935b;
			font-size: 0.74rem;
			font-weight: 800;
		}

		.fuzzy-top-status[data-mode="checking"] {
			background: #f0f1f8;
			color: #656b88;
		}

		.fuzzy-top-status[data-mode="native"] {
			background: #d8f6ff;
			color: #00759a;
		}

		.fuzzy-close-button {
			border: 0;
			border-radius: 10px;
			padding: 10px 14px;
			background: #ffffff;
			color: #515873;
			font: inherit;
			font-size: 0.84rem;
			font-weight: 700;
			cursor: pointer;
		}

		.fuzzy-main {
			display: grid;
			gap: 18px;
		}

		.fuzzy-screen-header {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 20px;
		}

		.fuzzy-screen-kicker,
		.fuzzy-section-label {
			margin: 0 0 8px;
			color: #61688c;
			font-size: 0.75rem;
			font-weight: 800;
		}

		.fuzzy-screen-header h1,
		.fuzzy-note-copy,
		.fuzzy-empty p,
		.fuzzy-search-meta p {
			margin: 0;
		}

		.fuzzy-screen-header h1 {
			font-size: 2rem;
			font-weight: 900;
			line-height: 1.12;
		}

		.fuzzy-search-panel,
		.fuzzy-search-results,
		.fuzzy-search-note,
		.fuzzy-placeholder,
		.fuzzy-empty {
			border-radius: 14px;
			background: #ffffff;
			box-shadow: 0 10px 28px rgba(58, 69, 120, 0.08);
		}

		.fuzzy-search-panel,
		.fuzzy-search-results,
		.fuzzy-search-note,
		.fuzzy-placeholder,
		.fuzzy-empty {
			padding: 16px;
		}

		.fuzzy-search-tabs {
			display: flex;
			gap: 10px;
			margin-bottom: 12px;
		}

		.fuzzy-chip {
			border: 0;
			border-radius: 10px;
			padding: 8px 14px;
			background: #eef0fb;
			color: #515873;
			font: inherit;
			font-size: 0.8rem;
			font-weight: 800;
		}

		.fuzzy-chip.is-active {
			background: #ffffff;
			color: #171a27;
			box-shadow: inset 0 0 0 1px #e0e4fb;
		}

		.fuzzy-search-form {
			display: grid;
			grid-template-columns: 1fr auto;
			gap: 12px;
			align-items: center;
		}

		.fuzzy-search-input-wrap {
			display: flex;
			align-items: center;
			gap: 12px;
			border: 2px solid #6c63ff;
			border-radius: 14px;
			padding: 12px 14px;
			background: #ffffff;
		}

		.fuzzy-search-dot {
			width: 14px;
			height: 14px;
			border-radius: 5px;
			background: #6c63ff;
			flex: 0 0 auto;
		}

		.fuzzy-search-input-wrap input {
			width: 100%;
			min-width: 0;
			border: 0;
			outline: 0;
			background: transparent;
			color: #151515;
			font: inherit;
			font-size: 1rem;
			font-weight: 800;
		}

		.fuzzy-primary-button {
			border: 0;
			border-radius: 12px;
			padding: 12px 22px;
			background: #6c63ff;
			color: #ffffff;
			font: inherit;
			font-weight: 800;
			cursor: pointer;
		}

		.fuzzy-search-meta {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 16px;
			margin-top: 12px;
			color: #61688c;
			font-size: 0.82rem;
			font-weight: 700;
		}

		.fuzzy-toggle {
			display: inline-flex;
			align-items: center;
			gap: 10px;
			color: #767d9f;
		}

		.fuzzy-toggle input {
			display: none;
		}

		.fuzzy-toggle-ui {
			position: relative;
			width: 36px;
			height: 20px;
			border-radius: 999px;
			background: #d5d9ed;
		}

		.fuzzy-toggle-ui::after {
			content: "";
			position: absolute;
			top: 3px;
			left: 3px;
			width: 14px;
			height: 14px;
			border-radius: 50%;
			background: #ffffff;
		}

		.fuzzy-search-layout {
			display: grid;
			grid-template-columns: minmax(0, 1.9fr) minmax(260px, 0.95fr);
			gap: 18px;
		}

		.fuzzy-result-list {
			display: grid;
			gap: 12px;
		}

		.fuzzy-result-row {
			display: grid;
			grid-template-columns: 48px minmax(0, 170px) minmax(0, 1fr) 86px;
			gap: 14px;
			align-items: center;
			border: 0;
			border-radius: 12px;
			padding: 14px;
			background: #ffffff;
			box-shadow: inset 0 0 0 1px #eceefd;
			color: inherit;
			text-align: left;
			cursor: pointer;
		}

		.fuzzy-result-row.is-selected {
			box-shadow: inset 0 0 0 2px #6c63ff;
			background: #f7f8ff;
		}

		.fuzzy-result-kind {
			display: inline-grid;
			place-items: center;
			border-radius: 8px;
			padding: 8px 0;
			background: #ff6b6b;
			color: #ffffff;
			font-size: 0.68rem;
			font-weight: 900;
		}

		.fuzzy-result-kind.is-ppt {
			background: #ffb53f;
		}

		.fuzzy-result-kind.is-doc {
			background: #4f8dff;
		}

		.fuzzy-result-title,
		.fuzzy-result-sub,
		.fuzzy-result-snippet,
		.fuzzy-result-side p,
		.fuzzy-note-grid dt,
		.fuzzy-note-grid dd {
			margin: 0;
		}

		.fuzzy-result-title {
			font-size: 0.95rem;
			font-weight: 900;
		}

		.fuzzy-result-sub {
			margin-top: 4px;
			color: #7a81a1;
			font-size: 0.74rem;
			font-weight: 700;
		}

		.fuzzy-result-snippet {
			color: #555d7a;
			font-size: 0.84rem;
			line-height: 1.7;
		}

		.fuzzy-result-side {
			display: grid;
			gap: 8px;
			justify-items: end;
			color: #6c63ff;
			font-size: 0.78rem;
			font-weight: 900;
		}

		.fuzzy-result-side span {
			border-radius: 10px;
			padding: 8px 12px;
			background: #eff0fe;
		}

		.fuzzy-search-note {
			background:
				linear-gradient(145deg, rgba(108, 99, 255, 0.12), transparent 48%),
				#ffffff;
		}

		.fuzzy-search-note h2,
		.fuzzy-empty h2,
		.fuzzy-placeholder h2 {
			margin: 0 0 10px;
			font-size: 1.18rem;
			font-weight: 900;
		}

		.fuzzy-note-copy {
			color: #555d7a;
			font-size: 0.9rem;
			line-height: 1.8;
		}

		.fuzzy-note-grid {
			display: grid;
			gap: 10px;
			margin: 18px 0 0;
		}

		.fuzzy-note-grid div {
			display: grid;
			grid-template-columns: 54px 1fr;
			gap: 10px;
		}

		.fuzzy-note-grid dt {
			color: #7a81a1;
			font-size: 0.76rem;
			font-weight: 800;
		}

		.fuzzy-note-grid dd {
			font-size: 0.86rem;
			font-weight: 800;
		}

		.fuzzy-placeholder {
			color: #5d6483;
			font-size: 0.95rem;
			line-height: 1.8;
		}

		.fuzzy-loading,
		.fuzzy-error {
			margin: 0;
			font-weight: 800;
		}

		.fuzzy-error {
			color: #c84833;
		}

		.fuzzy-nav-button:focus,
		.fuzzy-side-link:focus,
		.fuzzy-close-button:focus,
		.fuzzy-primary-button:focus,
		.fuzzy-result-row:focus,
		.fuzzy-search-input-wrap:focus-within {
			outline: 3px solid rgba(108, 99, 255, 0.28);
			outline-offset: 2px;
		}

		@media (max-width: 1080px) {
			#${PAGE_ID} {
				grid-template-columns: 1fr;
			}

			.fuzzy-sidebar {
				grid-template-rows: auto auto auto;
			}

			.fuzzy-side-nav {
				grid-template-columns: repeat(2, minmax(0, 1fr));
			}

			.fuzzy-search-layout {
				grid-template-columns: 1fr;
			}
		}

		@media (max-width: 760px) {
			.fuzzy-content {
				padding: 14px;
			}

			.fuzzy-screen-header h1 {
				font-size: 1.5rem;
			}

			.fuzzy-search-form {
				grid-template-columns: 1fr;
			}

			.fuzzy-result-row {
				grid-template-columns: 1fr;
			}

			.fuzzy-result-side {
				justify-items: start;
			}
		}
	`;

	document.head.append(style);
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
