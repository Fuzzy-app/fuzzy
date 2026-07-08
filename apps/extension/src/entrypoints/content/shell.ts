// Fuzzyシェル本体（issue54: 横断検索UIの土台）。
// Moodleの上部ナビに「Fuzzy」タブを追加し、開くと本文領域をFuzzyの画面
// （左サイドバー＋各機能画面）へ差し替える。閉じると元のMoodle本文を復元する。
//
// 【XSS対策の方針】
// ファイル名・スニペット・授業名などの動的な文字列は、Moodleから保存した資料に
// 由来する「外部データ」なので信用しない。DOMへ入れる際は必ず textContent /
// dataset を経由し、HTML文字列の組み立て（innerHTML等）には一切混ぜないこと。
// このモジュールでは動的データを含むHTML文字列を組み立てる箇所を意図的に無くしている。

import {
	type Assignment,
	type FuzzyApiClient,
	type SearchResult,
	createApiClient,
} from "@fuzzy/shared";

const ROOT_ID = "fuzzy-shell-root";
const STYLE_ID = "fuzzy-shell-style";
const BUTTON_ID = "fuzzy-shell-nav-button";
const PAGE_ID = "fuzzy-shell-page";
const STASH_ID = "fuzzy-shell-stash";

type ConnectionMode = FuzzyApiClient["mode"] | "checking";
type ScreenId = "dashboard" | "search" | "deadlines" | "courses" | "organize";
type DeadlineFilter = "all" | "upcoming" | "overdue" | "review";

interface MenuItem {
	id: ScreenId;
	label: string;
	enabled: boolean;
	description: string;
}

const menuItems: readonly MenuItem[] = [
	{ id: "dashboard", label: "ダッシュボード", enabled: false, description: "issue57 で実装" },
	{ id: "search", label: "横断検索", enabled: true, description: "issue54" },
	{ id: "deadlines", label: "締切ハブ", enabled: true, description: "issue55" },
	{ id: "courses", label: "コース一覧", enabled: false, description: "今後の画面" },
	{ id: "organize", label: "重複の整理", enabled: false, description: "今後の画面" },
];

const placeholderCopy: Record<Exclude<ScreenId, "search">, { title: string; copy: string }> = {
	dashboard: { title: "ダッシュボード", copy: "issue57 で実装する予定です。" },
	deadlines: {
		title: "締切ハブ",
		copy: "issue55 でこのメニューが有効になり、課題一覧と提出状況の切り替えが追加されます。",
	},
	courses: { title: "コース一覧", copy: "今後の画面としてここへ統合していきます。" },
	organize: { title: "重複の整理", copy: "保存済み資料の整理UIをここへ追加する予定です。" },
};

interface SearchState {
	/** 入力欄の現在値（inputイベントで随時同期） */
	query: string;
	/** 直近に実行した検索語（件数表示に使う） */
	executedQuery: string;
	results: SearchResult[];
	selectedResultId: number | null;
	loading: boolean;
	error: string | null;
}

interface SearchScreen {
	root: HTMLElement;
	input: HTMLInputElement;
	submitButton: HTMLButtonElement;
	countLabel: HTMLElement;
	resultsHost: HTMLElement;
	noteHost: HTMLElement;
}

function getNow(): number {
	return new Date("2026-07-08T00:00:00+09:00").getTime();
}

function isNeedsReview(assignment: Assignment): boolean {
	return assignment.dueAtStatus === "needs_review";
}

function isOverdue(assignment: Assignment): boolean {
	return Boolean(
		assignment.dueAt &&
			!assignment.submitted &&
			new Date(assignment.dueAt).getTime() < getNow(),
	);
}

function isUpcoming(assignment: Assignment): boolean {
	return (
		!assignment.submitted &&
		(!assignment.dueAt || new Date(assignment.dueAt).getTime() >= getNow())
	);
}

function formatDate(dueAt: string | null): string {
	if (!dueAt) return "期限未設定";
	return new Intl.DateTimeFormat("ja-JP", {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(dueAt));
}

function submissionLabel(assignment: Assignment): string {
	switch (assignment.submissionMode) {
		case "moodle_auto":
			return "Moodle提出";
		case "manual":
			return "手動提出";
		case "notify_only":
			return "通知のみ";
		default:
			return "確認中";
	}
}

function sourceLabel(assignment: Assignment): string {
	switch (assignment.source) {
		case "moodle_dashboard":
			return "Moodleダッシュボード";
		case "moodle_text":
			return "Moodle本文";
		case "file_content":
			return "資料本文";
	}
}

function deadlineFilterLabel(filter: DeadlineFilter): string {
	switch (filter) {
		case "upcoming":
			return "今後";
		case "overdue":
			return "期限切れ";
		case "review":
			return "要確認";
		default:
			return "すべて";
	}
}

export function mountFuzzyShell(): void {
	if (document.getElementById(ROOT_ID)) return;

	const navHost = findNavHost();
	const mainHost = findMainHost();
	if (!navHost || !mainHost) {
		console.warn("[fuzzy] ナビゲーションまたは本文領域が見つかりませんでした");
		return;
	}

	ensureStyle();

	// --- ナビボタン ---
	const navButton = el("button", "fuzzy-nav-button");
	navButton.id = BUTTON_ID;
	navButton.type = "button";
	navButton.setAttribute("aria-pressed", "false");
	navButton.append(el("span", "fuzzy-nav-mark", "F"), el("span", "", "Fuzzy"));

	const root = el(navHost.tagName === "UL" ? "li" : "div");
	root.id = ROOT_ID;
	root.append(navButton);
	navHost.append(root);

	// シェルを開いている間、Moodle本文の退避先になる要素
	const stash = el("div");
	stash.id = STASH_ID;
	stash.hidden = true;
	mainHost.after(stash);

	// --- 状態 ---
	const apiPromise = createApiClient();
	let page: HTMLElement | null = null;
	let mainEl: HTMLElement | null = null;
	let statusBadge: HTMLElement | null = null;
	let searchScreen: SearchScreen | null = null;
	const sideLinks: HTMLButtonElement[] = [];
	let isOpen = false;
	let activeScreen: ScreenId = "search";
	let mode: ConnectionMode = "checking";
	let deadlineFilter: DeadlineFilter = "all";
	let assignments: Assignment[] = [];
	let assignmentsLoaded = false;
	let loadingDeadlines = false;
	const searchState: SearchState = {
		query: "",
		executedQuery: "",
		results: [],
		selectedResultId: null,
		loading: false,
		error: null,
	};

	const moveMainContentToStash = () => {
		while (mainHost.firstChild) stash.append(mainHost.firstChild);
	};

	const restoreMainContent = () => {
		while (stash.firstChild) mainHost.append(stash.firstChild);
	};

	const setTopMode = (nextMode: ConnectionMode) => {
		mode = nextMode;
		if (!statusBadge) return;
		statusBadge.dataset.mode = mode;
		statusBadge.textContent =
			mode === "native"
				? "完全ローカル・実データ接続"
				: mode === "mock"
					? "完全ローカル・サンプル表示"
					: "接続確認中";
	};

	// --- 検索画面 ---

	/** 選択中の候補パネルと結果行のハイライトだけを更新する（一覧は作り直さない） */
	const renderSelection = () => {
		if (!searchScreen) return;
		const selected =
			searchState.results.find((result) => result.fileId === searchState.selectedResultId) ?? null;

		for (const row of searchScreen.resultsHost.querySelectorAll<HTMLButtonElement>(
			".fuzzy-result-row",
		)) {
			row.classList.toggle(
				"is-selected",
				selected !== null && Number(row.dataset.fileId) === selected.fileId,
			);
		}

		const note = searchScreen.noteHost;
		if (!selected) {
			note.replaceChildren(
				el("p", "fuzzy-section-label", "検索のメモ"),
				el("h2", "", "資料の所在を見つける"),
				el(
					"p",
					"fuzzy-note-copy",
					"スニペットは検索語の前後だけを短く抜き出した本文です。まずは「正規化」で確認できます。",
				),
			);
			return;
		}

		const grid = el("dl", "fuzzy-note-grid");
		const addNoteRow = (term: string, detail: string) => {
			const rowEl = el("div");
			rowEl.append(el("dt", "", term), el("dd", "", detail));
			grid.append(rowEl);
		};
		addNoteRow("授業", selected.courseName ?? "未設定");
		addNoteRow("ページ", selected.page === null ? "ページ情報なし" : `${selected.page}ページ`);
		addNoteRow("一致度", `${Math.round(selected.score * 100)}%`);

		note.replaceChildren(
			el("p", "fuzzy-section-label", "選択中の候補"),
			el("h2", "", selected.fileName),
			el(
				"p",
				"fuzzy-note-copy",
				selected.page === null
					? "該当箇所を見つけました。ページ情報は未登録です。"
					: `${selected.page}ページ付近に該当箇所があります。`,
			),
			grid,
		);
	};

	const createResultRow = (result: SearchResult): HTMLButtonElement => {
		const row = el("button", "fuzzy-result-row");
		row.type = "button";
		row.dataset.fileId = String(result.fileId);

		const kindClass = fileKindClass(result.fileName);
		const kind = el(
			"div",
			kindClass ? `fuzzy-result-kind ${kindClass}` : "fuzzy-result-kind",
			fileKindLabel(result.fileName),
		);

		const main = el("div", "fuzzy-result-main");
		main.append(
			el("p", "fuzzy-result-title", result.fileName),
			el("p", "fuzzy-result-sub", result.courseName ?? "授業名なし"),
		);

		const side = el("div", "fuzzy-result-side");
		side.append(
			el("p", "", result.page === null ? "—" : `p.${result.page}`),
			el("span", "", result.page === null ? "ファイルを開く" : "ページへ"),
		);

		row.append(kind, main, el("p", "fuzzy-result-snippet", result.snippet), side);
		return row;
	};

	/** 検索結果まわり（件数・一覧・選択パネル）だけを更新する。入力欄には触らない */
	const renderSearchResults = () => {
		if (!searchScreen) return;
		const { submitButton, countLabel, resultsHost } = searchScreen;

		submitButton.textContent = searchState.loading ? "検索中…" : "検索";
		submitButton.disabled = searchState.loading;
		countLabel.textContent = searchState.executedQuery
			? `「${searchState.executedQuery}」に一致: ${searchState.results.length}ファイル`
			: "キーワードを入力してください";

		if (searchState.error) {
			resultsHost.replaceChildren(
				el("p", "fuzzy-error", `検索に失敗しました: ${searchState.error}`),
			);
		} else if (searchState.loading) {
			resultsHost.replaceChildren(el("p", "fuzzy-loading", "検索中…"));
		} else if (searchState.results.length === 0) {
			const empty = el("section", "fuzzy-empty");
			empty.append(
				el(
					"h2",
					"",
					searchState.executedQuery ? "一致する資料がありません" : "まだ結果がありません",
				),
				el("p", "", "サンプルでは「正規化」で結果が表示されます。"),
			);
			resultsHost.replaceChildren(empty);
		} else {
			const list = el("div", "fuzzy-result-list");
			list.append(...searchState.results.map(createResultRow));
			resultsHost.replaceChildren(
				el("p", "fuzzy-section-label", "該当箇所順（関連が高い順）"),
				list,
			);
		}

		renderSelection();
	};

	const runSearch = async () => {
		const query = searchState.query.trim();
		if (!query) {
			searchState.error = "検索したいワードを入力してください。";
			searchState.executedQuery = "";
			searchState.results = [];
			searchState.selectedResultId = null;
			renderSearchResults();
			return;
		}

		searchState.loading = true;
		searchState.error = null;
		renderSearchResults();

		try {
			const api = await apiPromise;
			searchState.results = await api.search(query);
			searchState.executedQuery = query;
			searchState.selectedResultId = searchState.results[0]?.fileId ?? null;
			setTopMode(api.mode);
		} catch (error) {
			searchState.error = error instanceof Error ? error.message : String(error);
			searchState.executedQuery = query;
			searchState.results = [];
			searchState.selectedResultId = null;
		} finally {
			searchState.loading = false;
			renderSearchResults();
		}
	};

	const buildSearchScreen = (): SearchScreen => {
		const screen = el("div", "fuzzy-screen");
		screen.append(buildScreenHeader("横断検索", "どのファイルに載っているか"));

		const panel = el("section", "fuzzy-search-panel");

		const tabs = el("div", "fuzzy-search-tabs");
		const keywordTab = el("button", "fuzzy-chip is-active", "キーワード");
		keywordTab.type = "button";
		const courseTab = el("button", "fuzzy-chip", "講義で検索");
		courseTab.type = "button";
		courseTab.disabled = true;
		tabs.append(keywordTab, courseTab);

		const form = el("form", "fuzzy-search-form");
		const inputWrap = el("div", "fuzzy-search-input-wrap");
		const input = el("input");
		input.id = "fuzzy-search-input";
		input.type = "search";
		input.setAttribute("aria-label", "検索キーワード");
		input.placeholder = "調べたい単語を入力";
		inputWrap.append(el("span", "fuzzy-search-dot"), input);
		const submitButton = el("button", "fuzzy-primary-button", "検索");
		submitButton.type = "submit";
		form.append(inputWrap, submitButton);

		const meta = el("div", "fuzzy-search-meta");
		const countLabel = el("p", "", "キーワードを入力してください");
		const toggle = el("label", "fuzzy-toggle");
		const toggleInput = el("input");
		toggleInput.type = "checkbox";
		toggleInput.disabled = true;
		toggle.append(
			el("span", "", "AIで要約（任意・実験的）"),
			toggleInput,
			el("span", "fuzzy-toggle-ui"),
		);
		meta.append(countLabel, toggle);

		panel.append(tabs, form, meta);

		const layout = el("section", "fuzzy-search-layout");
		const resultsHost = el("div", "fuzzy-search-results");
		const noteHost = el("div", "fuzzy-search-note");
		layout.append(resultsHost, noteHost);

		screen.append(panel, layout);

		// 入力値は状態へ随時同期する。再描画するのは結果領域だけなので入力途中の文字は消えない
		input.addEventListener("input", () => {
			searchState.query = input.value;
		});
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			void runSearch();
		});
		// 結果行のクリックはイベント委譲で受け、選択まわりだけを更新する
		resultsHost.addEventListener("click", (event) => {
			if (!(event.target instanceof Element)) return;
			const row = event.target.closest<HTMLButtonElement>(".fuzzy-result-row");
			if (!row?.dataset.fileId) return;
			searchState.selectedResultId = Number(row.dataset.fileId);
			renderSelection();
		});

		return { root: screen, input, submitButton, countLabel, resultsHost, noteHost };
	};

	const getSearchScreen = (): SearchScreen => {
		if (!searchScreen) {
			searchScreen = buildSearchScreen();
			renderSearchResults();
		}
		return searchScreen;
	};

	const loadAssignments = async () => {
		if (assignmentsLoaded) return;
		const api = await apiPromise;
		assignments = await api.getDeadlines({ includePast: true });
		assignmentsLoaded = true;
		setTopMode(api.mode);
	};

	const filterAssignments = (): Assignment[] => {
		switch (deadlineFilter) {
			case "upcoming":
				return assignments.filter(isUpcoming);
			case "overdue":
				return assignments.filter(isOverdue);
			case "review":
				return assignments.filter(isNeedsReview);
			default:
				return assignments;
		}
	};

	const sortAssignments = (list: Assignment[]): Assignment[] =>
		[...list].sort((a, b) => {
			if (a.submitted !== b.submitted) return a.submitted ? 1 : -1;
			if (isNeedsReview(a) !== isNeedsReview(b)) return isNeedsReview(a) ? -1 : 1;
			const aTime = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
			const bTime = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
			return aTime - bTime;
		});

	const buildDeadlineCard = (assignment: Assignment): HTMLElement => {
		const card = el("article", "fuzzy-deadline-card");
		if (assignment.submitted) card.classList.add("is-submitted");
		if (isNeedsReview(assignment)) card.classList.add("is-review");
		if (isOverdue(assignment)) card.classList.add("is-overdue");

		const head = el("div", "fuzzy-deadline-head");
		const heading = el("div");
		heading.append(
			el("p", "fuzzy-course-name", assignment.courseName),
			el("h2", "", assignment.title),
		);

		const badges = el("div", "fuzzy-deadline-badges");
		badges.append(el("span", "fuzzy-badge", submissionLabel(assignment)));
		if (isNeedsReview(assignment)) badges.append(el("span", "fuzzy-badge is-review", "要確認"));
		if (isOverdue(assignment)) badges.append(el("span", "fuzzy-badge is-overdue", "期限切れ"));
		badges.append(
			el(
				"span",
				assignment.submitted ? "fuzzy-badge is-submitted" : "fuzzy-badge is-open",
				assignment.submitted ? "提出済み" : "未提出",
			),
		);
		head.append(heading, badges);

		const body = el("div", "fuzzy-deadline-body");
		const dueWrap = el("div");
		dueWrap.append(
			el("p", "fuzzy-deadline-label", "期限"),
			el("p", "fuzzy-deadline-value", formatDate(assignment.dueAt)),
		);
		body.append(dueWrap, el("p", "fuzzy-deadline-source", sourceLabel(assignment)));

		const checkLabel = el("label", "fuzzy-checkline");
		const checkbox = el("input") as HTMLInputElement;
		checkbox.type = "checkbox";
		checkbox.dataset.id = String(assignment.id);
		checkbox.checked = assignment.submitted;
		checkbox.addEventListener("change", async () => {
			const submitted = checkbox.checked;
			checkbox.disabled = true;
			try {
				const api = await apiPromise;
				await api.updateSubmissionStatus(assignment.id, submitted);
				assignments = assignments.map((item) =>
					item.id === assignment.id ? { ...item, submitted } : item,
				);
				renderScreen();
			} finally {
				checkbox.disabled = false;
			}
		});
		checkLabel.append(checkbox, el("span", "", "提出済みにする"));

		card.append(head, body, checkLabel);
		return card;
	};

	const buildDeadlineScreen = (): HTMLElement => {
		const screen = el("div", "fuzzy-screen");
		screen.append(buildScreenHeader("締切ハブ", "課題と提出状況をまとめて確認"));

		if (loadingDeadlines && !assignmentsLoaded) {
			screen.append(el("section", "fuzzy-placeholder", "締切データを読み込んでいます…"));
			return screen;
		}

		const metricGrid = el("section", "fuzzy-metric-grid");
		const metrics: Array<{ label: string; value: number; className?: string }> = [
			{ label: "未提出", value: assignments.filter((item) => !item.submitted).length },
			{ label: "要確認", value: assignments.filter(isNeedsReview).length, className: "is-warn" },
			{ label: "期限切れ", value: assignments.filter(isOverdue).length, className: "is-soft" },
		];
		for (const metric of metrics) {
			const card = el(
				"article",
				metric.className ? `fuzzy-metric-card ${metric.className}` : "fuzzy-metric-card",
			);
			card.append(
				el("p", "fuzzy-metric-label", metric.label),
				el("p", "fuzzy-metric-value", String(metric.value)),
			);
			metricGrid.append(card);
		}

		const toolbar = el("section", "fuzzy-deadline-toolbar");
		const filterRow = el("div", "fuzzy-filter-row");
		for (const filter of ["all", "upcoming", "overdue", "review"] as const) {
			const button = el(
				"button",
				deadlineFilter === filter ? "fuzzy-filter-chip is-active" : "fuzzy-filter-chip",
				deadlineFilterLabel(filter),
			);
			button.type = "button";
			button.addEventListener("click", () => {
				deadlineFilter = filter;
				renderScreen();
			});
			filterRow.append(button);
		}
		toolbar.append(
			filterRow,
			el(
				"p",
				"fuzzy-toolbar-copy",
				"提出済みにすると一覧へ即反映されます。要確認は期限の再確認が必要な課題です。",
			),
		);

		const listHost = el("section", "fuzzy-deadline-list");
		const visible = sortAssignments(filterAssignments());
		if (visible.length === 0) {
			const empty = el("section", "fuzzy-empty");
			empty.append(
				el("h2", "", "表示できる課題がありません"),
				el("p", "", "この条件に合う締切は今のところ見つかっていません。"),
			);
			listHost.append(empty);
		} else {
			listHost.append(...visible.map(buildDeadlineCard));
		}

		screen.append(metricGrid, toolbar, listHost);
		return screen;
	};

	const buildPlaceholderScreen = (screenId: Exclude<ScreenId, "search">): HTMLElement => {
		const { title, copy } = placeholderCopy[screenId];
		const screen = el("div", "fuzzy-screen");
		screen.append(buildScreenHeader("準備中", title));
		const section = el("section", "fuzzy-placeholder");
		section.append(el("p", "", copy));
		screen.append(section);
		return screen;
	};

	const renderScreen = () => {
		for (const link of sideLinks) {
			const isActive = link.dataset.screen === activeScreen;
			link.classList.toggle("is-active", isActive);
			if (isActive) link.setAttribute("aria-current", "page");
			else link.removeAttribute("aria-current");
		}

		if (!mainEl) return;
		if (activeScreen === "search") {
			// 検索画面はキャッシュして使い回す（入力値・結果・選択状態を保持する）
			mainEl.replaceChildren(getSearchScreen().root);
		} else if (activeScreen === "deadlines") {
			mainEl.replaceChildren(buildDeadlineScreen());
			if (!assignmentsLoaded && !loadingDeadlines) {
				loadingDeadlines = true;
				void loadAssignments().finally(() => {
					loadingDeadlines = false;
					if (activeScreen === "deadlines") renderScreen();
				});
			}
		} else {
			mainEl.replaceChildren(buildPlaceholderScreen(activeScreen));
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

	const buildPage = (): HTMLElement => {
		if (page) return page;

		page = el("section", "fuzzy-shell");
		page.id = PAGE_ID;

		const sidebar = el("div", "fuzzy-sidebar");
		const brand = el("div", "fuzzy-brand");
		brand.append(el("span", "fuzzy-brand-mark", "F"), el("span", "", "Fuzzy"));

		const nav = el("nav", "fuzzy-side-nav");
		nav.setAttribute("aria-label", "Fuzzy menu");
		for (const item of menuItems) {
			const link = el("button", item.enabled ? "fuzzy-side-link" : "fuzzy-side-link is-disabled");
			link.type = "button";
			link.dataset.screen = item.id;
			link.disabled = !item.enabled;
			link.title = item.description;
			link.append(el("span", "fuzzy-side-dot"), el("span", "", item.label));
			link.addEventListener("click", () => {
				activeScreen = item.id;
				renderScreen();
			});
			sideLinks.push(link);
			nav.append(link);
		}

		const footer = el("div", "fuzzy-sidebar-footer");
		footer.append(el("p", "", "開発中"), el("span", "", "issue54 + issue55"));
		sidebar.append(brand, nav, footer);

		const content = el("div", "fuzzy-content");
		const topbar = el("header", "fuzzy-topbar");
		statusBadge = el("p", "fuzzy-top-status");
		setTopMode(mode);
		const closeButton = el("button", "fuzzy-close-button", "Moodleに戻る");
		closeButton.type = "button";
		closeButton.addEventListener("click", closeShell);
		topbar.append(statusBadge, closeButton);
		mainEl = el("main", "fuzzy-main");
		content.append(topbar, mainEl);

		page.append(sidebar, content);
		renderScreen();
		return page;
	};

	const openShell = () => {
		if (isOpen) return;
		isOpen = true;
		navButton.classList.add("is-active");
		navButton.setAttribute("aria-pressed", "true");
		moveMainContentToStash();
		mainHost.append(buildPage());

		// 接続モードの表示だけ非同期で更新する（検索は自動では実行しない）
		void apiPromise.then(
			(api) => setTopMode(api.mode),
			() => setTopMode("checking"),
		);
	};

	navButton.addEventListener("click", () => {
		if (isOpen) closeShell();
		else openShell();
	});

	// Moodle側の別タブ（Home等）を押したときはFuzzyを閉じて本文を戻す
	navHost.addEventListener("click", (event) => {
		if (!(event.target instanceof Element)) return;
		const otherNavItem = event.target.closest("a, button");
		if (!otherNavItem || otherNavItem === navButton) return;
		closeShell();
	});
}

/**
 * createElement の薄いラッパー。動的な文字列は textContent 経由でのみDOMへ入れる
 * （HTML文字列の組み立てを避けることで、エスケープ漏れによるXSSを構造的に防ぐ）。
 */
function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className = "",
	textContent = "",
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (textContent) node.textContent = textContent;
	return node;
}

function buildScreenHeader(kicker: string, title: string): HTMLElement {
	const header = el("header", "fuzzy-screen-header");
	const wrap = el("div");
	wrap.append(el("p", "fuzzy-screen-kicker", kicker), el("h1", "", title));
	header.append(wrap);
	return header;
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

		.fuzzy-screen {
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
			padding: 16px;
			border-radius: 14px;
			background: #ffffff;
			box-shadow: 0 10px 28px rgba(58, 69, 120, 0.08);
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

		.fuzzy-metric-grid {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 14px;
		}

		.fuzzy-metric-card {
			padding: 16px;
		}

		.fuzzy-metric-card.is-warn {
			background: #fff8df;
		}

		.fuzzy-metric-card.is-soft {
			background: #f4f5fb;
		}

		.fuzzy-metric-label {
			margin: 0;
			color: #6b7292;
			font-size: 0.8rem;
			font-weight: 800;
		}

		.fuzzy-metric-value {
			margin: 10px 0 0;
			font-size: 2rem;
			font-weight: 900;
			line-height: 1;
		}

		.fuzzy-deadline-toolbar {
			padding: 14px;
			border-radius: 14px;
			background: #ffffff;
			box-shadow: 0 10px 28px rgba(58, 69, 120, 0.08);
		}

		.fuzzy-filter-row {
			display: flex;
			flex-wrap: wrap;
			gap: 10px;
			margin-bottom: 10px;
		}

		.fuzzy-filter-chip {
			border: 0;
			border-radius: 999px;
			padding: 8px 14px;
			background: #eef0fb;
			color: #59607d;
			font: inherit;
			font-size: 0.8rem;
			font-weight: 800;
			cursor: pointer;
		}

		.fuzzy-filter-chip.is-active {
			background: #6c63ff;
			color: #ffffff;
		}

		.fuzzy-toolbar-copy {
			margin: 0;
			color: #636b8b;
			font-size: 0.84rem;
			line-height: 1.7;
		}

		.fuzzy-deadline-list {
			display: grid;
			gap: 14px;
		}

		.fuzzy-deadline-card {
			padding: 16px;
			border-radius: 14px;
			background: #ffffff;
			box-shadow: 0 10px 28px rgba(58, 69, 120, 0.08);
		}

		.fuzzy-deadline-card.is-review {
			background: #fff8df;
		}

		.fuzzy-deadline-card.is-overdue {
			box-shadow:
				inset 4px 0 0 #ff8a5b,
				0 10px 28px rgba(58, 69, 120, 0.08);
		}

		.fuzzy-deadline-card.is-submitted {
			opacity: 0.72;
		}

		.fuzzy-deadline-head {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 14px;
		}

		.fuzzy-course-name {
			margin: 0 0 4px;
			color: #7a81a1;
			font-size: 0.76rem;
			font-weight: 800;
		}

		.fuzzy-deadline-head h2 {
			margin: 0;
			font-size: 1.06rem;
			font-weight: 900;
		}

		.fuzzy-deadline-badges {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			justify-content: flex-end;
		}

		.fuzzy-badge {
			border-radius: 999px;
			padding: 6px 10px;
			background: #eef0fb;
			font-size: 0.74rem;
			font-weight: 800;
		}

		.fuzzy-badge.is-review {
			background: #ffe38c;
		}

		.fuzzy-badge.is-overdue {
			background: #ffd8cc;
		}

		.fuzzy-badge.is-submitted {
			background: #dff4e7;
		}

		.fuzzy-badge.is-open {
			background: #e3e8fb;
		}

		.fuzzy-deadline-body {
			display: grid;
			gap: 6px;
			margin-top: 12px;
		}

		.fuzzy-deadline-label {
			margin: 0;
			color: #7a81a1;
			font-size: 0.76rem;
			font-weight: 800;
		}

		.fuzzy-deadline-value {
			margin: 0;
			font-size: 0.95rem;
			font-weight: 900;
		}

		.fuzzy-deadline-source {
			margin: 0;
			color: #626a89;
			font-size: 0.82rem;
			line-height: 1.7;
		}

		.fuzzy-checkline {
			display: inline-flex;
			align-items: center;
			gap: 10px;
			margin-top: 14px;
			font-size: 0.84rem;
			font-weight: 800;
		}

		.fuzzy-placeholder {
			color: #5d6483;
			font-size: 0.95rem;
			line-height: 1.8;
		}

		.fuzzy-placeholder p {
			margin: 0;
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
		.fuzzy-filter-chip:focus,
		.fuzzy-checkline input:focus,
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

			.fuzzy-metric-grid {
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

			.fuzzy-deadline-head {
				flex-direction: column;
			}

			.fuzzy-deadline-badges {
				justify-content: flex-start;
			}
		}
	`;

	document.head.append(style);
}
