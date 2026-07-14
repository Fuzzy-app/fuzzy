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
	type AssignmentChange,
	type DashboardSummary,
	type DataSyncEvent,
	type FuzzyApiClient,
	type SearchResult,
	createApiClient,
} from "@fuzzy/shared";
import { readDashboardCache, writeDashboardCache } from "../../lib/cache/dashboardCache";
import { createRuleManagementStore } from "../../lib/rules/state";
import { type RuleManagementScreen, createRuleManagementScreen } from "./rulesScreen";

const ROOT_ID = "fuzzy-shell-root";
const STYLE_ID = "fuzzy-shell-style";
const BUTTON_ID = "fuzzy-shell-nav-button";
const DRAWER_BUTTON_ID = "fuzzy-shell-drawer-button";
const PAGE_ID = "fuzzy-shell-page";
const STASH_ID = "fuzzy-shell-stash";

type ConnectionMode = FuzzyApiClient["mode"] | "checking";
type ScreenId = "dashboard" | "search" | "deadlines" | "courses" | "rules" | "organize";
// 画面上のフィルタ種別。@fuzzy/shared のAPI取得フィルタ `DeadlineFilter` とは別物なので、
// import 時の衝突・混同を避けるため View 用として別名にしている。
type DeadlineViewFilter = "all" | "upcoming" | "overdue" | "review";

interface MenuItem {
	id: ScreenId;
	label: string;
	enabled: boolean;
	description: string;
}

const menuItems: readonly MenuItem[] = [
	{ id: "dashboard", label: "ダッシュボード", enabled: true, description: "issue57" },
	{ id: "search", label: "横断検索", enabled: true, description: "issue54" },
	{ id: "deadlines", label: "締切ハブ", enabled: true, description: "issue55" },
	{ id: "courses", label: "コース一覧", enabled: false, description: "今後の画面" },
	{ id: "rules", label: "整理ルール", enabled: true, description: "issue52" },
	{ id: "organize", label: "重複の整理", enabled: false, description: "今後の画面" },
];

const placeholderCopy: Record<
	Exclude<ScreenId, "search" | "dashboard" | "rules">,
	{ title: string; copy: string }
> = {
	deadlines: {
		title: "締切ハブ",
		copy: "課題一覧と提出状況を、この画面でまとめて確認できます。",
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
	selectedResultKey: string | null;
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
	return Date.now();
}

function parseDueAt(dueAt: string | null): number | null {
	if (!dueAt) return null;
	const time = Date.parse(dueAt);
	return Number.isNaN(time) ? null : time;
}

// 和歌山大学のセメスター区分。締切ハブではクオーター単位ではなくセメスター単位で扱う。
// 夏季集中などの特別授業も前期側に取り込めるよう、前期=4〜9月（[4,10)）／
// 後期=10〜3月（[10,4)）と年間を隙間なく二分する。壊れた日付の締切は具体的な日付を
// 出せないため、この区分を「おおよその所属セメスター」の目安として表示に使う。
type Semester = "first" | "second";

function semesterOf(time: number): Semester {
	const month = new Date(time).getMonth() + 1; // 1〜12
	return month >= 4 && month < 10 ? "first" : "second";
}

function semesterLabel(semester: Semester): string {
	return semester === "first" ? "前期" : "後期";
}

function isNeedsReview(assignment: Assignment): boolean {
	return (
		assignment.dueAtStatus === "needs_review" ||
		(assignment.dueAt !== null && parseDueAt(assignment.dueAt) === null)
	);
}

function isOverdue(assignment: Assignment): boolean {
	const dueTime = parseDueAt(assignment.dueAt);
	return Boolean(dueTime !== null && !assignment.submitted && dueTime < getNow());
}

function isUpcoming(assignment: Assignment): boolean {
	const dueTime = parseDueAt(assignment.dueAt);
	return (
		!assignment.submitted &&
		(assignment.dueAt === null || dueTime !== null) &&
		(dueTime === null || dueTime >= getNow()) &&
		!isNeedsReview(assignment)
	);
}

// フォーマッタ生成はコストが高いため、締切カードごとに作り直さずモジュールスコープで使い回す。
const dueAtFormatter = new Intl.DateTimeFormat("ja-JP", {
	month: "numeric",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
});

const cacheDateFormatter = new Intl.DateTimeFormat("ja-JP", {
	month: "numeric",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
});

function formatCacheDate(cachedAt: string): string {
	const time = Date.parse(cachedAt);
	return Number.isNaN(time) ? "日時不明" : cacheDateFormatter.format(new Date(time));
}

function formatDate(dueAt: string | null): string {
	if (!dueAt) return "期限未設定";
	const time = parseDueAt(dueAt);
	// 日付が壊れていて具体的な期限を出せない場合は、現在の和歌山大学のセメスターを
	// 目安として示す（例: 前期中に開くと「前期中・日付要確認」）。
	if (time === null) return `${semesterLabel(semesterOf(getNow()))}中・日付要確認`;
	return dueAtFormatter.format(new Date(time));
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

function deadlineFilterLabel(filter: DeadlineViewFilter): string {
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

const syncDateFormatter = new Intl.DateTimeFormat("ja-JP", {
	month: "numeric",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
});

function formatSyncDate(syncedAt: string): string {
	const time = Date.parse(syncedAt);
	if (Number.isNaN(time)) return "取得日時を確認してください";
	return syncDateFormatter.format(new Date(time));
}

function syncTriggerLabel(trigger: DataSyncEvent["trigger"]): string {
	return trigger === "manual" ? "手動取得" : "自動取得";
}

function assignmentChangeFieldLabel(field: AssignmentChange["field"]): string {
	switch (field) {
		case "dueAt":
			return "期限";
		case "title":
			return "課題名";
		case "submissionMode":
			return "提出方法";
		case "dueAtStatus":
			return "期限判定";
		case "submitted":
			return "提出状況";
	}
}

function assignmentChangeValueLabel(
	field: AssignmentChange["field"],
	value: string | null,
): string {
	if (value === null || value === "") return "未設定";
	if (field === "dueAt") return formatDate(value);
	if (field === "dueAtStatus") return value === "needs_review" ? "要確認" : "通常";
	if (field === "submitted") return value === "true" ? "提出済み" : "未提出";
	if (field === "submissionMode") {
		switch (value) {
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
	return value;
}

function syncChangeTotal(event: DataSyncEvent): number {
	return event.newAssignmentCount + event.changedAssignmentCount + event.removedAssignmentCount;
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

	// Moodleの自動折りたたみ処理に乗せるため、既存タブと同じ li.nav-item > a.nav-link で追加する。
	const navButton = el("a", "nav-link fuzzy-nav-button");
	navButton.id = BUTTON_ID;
	navButton.href = "#";
	navButton.setAttribute("aria-pressed", "false");
	navButton.append(el("span", "fuzzy-nav-mark", "F"), el("span", "", "Fuzzy"));

	const root = el(
		navHost.tagName === "UL" ? "li" : "div",
		navHost.tagName === "UL" ? "nav-item" : "",
	);
	root.id = ROOT_ID;
	root.append(navButton);
	insertNavRoot(navHost, root);

	// シェルを開いている間、Moodle本文の退避先になる要素
	const stash = el("div");
	stash.id = STASH_ID;
	stash.hidden = true;
	mainHost.after(stash);

	// --- 状態 ---
	const apiPromise = createApiClient();
	const ruleStore = createRuleManagementStore();
	let page: HTMLElement | null = null;
	let mainEl: HTMLElement | null = null;
	let statusBadge: HTMLElement | null = null;
	let searchScreen: SearchScreen | null = null;
	let ruleScreen: RuleManagementScreen | null = null;
	let drawerButton: HTMLAnchorElement | null = null;
	const sideLinks: HTMLButtonElement[] = [];
	let isOpen = false;
	let activeScreen: ScreenId = "search";
	let mode: ConnectionMode = "checking";
	let shellTopOffset = 0;
	let deadlineFilter: DeadlineViewFilter = "all";
	let assignments: Assignment[] = [];
	let assignmentsLoaded = false;
	let loadingDeadlines = false;
	let deadlineError: string | null = null;
	let submissionError: string | null = null;
	let dashboard: DashboardSummary | null = null;
	let dashboardCachedAt: string | null = null;
	let dashboardUsesCache = false;
	let dashboardLoaded = false;
	let loadingDashboard = false;
	let dashboardError: string | null = null;
	let latestSyncEvent: DataSyncEvent | null = null;
	let assignmentChanges: AssignmentChange[] = [];
	let loadingSyncSummary = false;
	let syncSummaryLoaded = false;
	let syncSummaryError: string | null = null;
	let searchRequestId = 0;
	const searchState: SearchState = {
		query: "",
		executedQuery: "",
		results: [],
		selectedResultKey: null,
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

	const applyShellFrame = () => {
		if (!page) return;
		page.style.top = `${shellTopOffset}px`;
		page.style.height = `calc(100vh - ${shellTopOffset}px)`;
	};

	const renderEntryState = () => {
		navButton.classList.toggle("is-active", isOpen);
		navButton.setAttribute("aria-pressed", String(isOpen));
		if (!drawerButton) return;
		drawerButton.classList.toggle("active", isOpen);
		drawerButton.setAttribute("aria-current", isOpen ? "page" : "false");
	};

	const ensureDrawerEntry = () => {
		const nextButton = upsertDrawerButton();
		if (!nextButton) return;
		if (drawerButton !== nextButton) {
			drawerButton = nextButton;
			drawerButton.addEventListener("click", (event) => {
				event.preventDefault();
				if (isOpen) closeShell();
				else openShell();
			});
		}
		renderEntryState();
	};

	// --- 検索画面 ---

	/** 選択中の候補パネルと結果行のハイライトだけを更新する（一覧は作り直さない） */
	const getResultKey = (result: SearchResult, index: number): string =>
		`${result.fileId}:${result.page ?? "none"}:${index}`;

	const renderSelection = () => {
		if (!searchScreen) return;
		const selected =
			searchState.results.find(
				(result, index) => getResultKey(result, index) === searchState.selectedResultKey,
			) ?? null;

		for (const row of searchScreen.resultsHost.querySelectorAll<HTMLButtonElement>(
			".fuzzy-result-row",
		)) {
			row.classList.toggle(
				"is-selected",
				selected !== null && row.dataset.resultKey === searchState.selectedResultKey,
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

	const createResultRow = (result: SearchResult, index: number): HTMLButtonElement => {
		const row = el("button", "fuzzy-result-row");
		row.type = "button";
		row.dataset.resultKey = getResultKey(result, index);

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
			el("span", "", "候補を見る"),
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
		const requestId = ++searchRequestId;
		const query = searchState.query.trim();
		if (!query) {
			searchState.loading = false;
			searchState.error = "検索したいワードを入力してください。";
			searchState.executedQuery = "";
			searchState.results = [];
			searchState.selectedResultKey = null;
			renderSearchResults();
			return;
		}

		searchState.loading = true;
		searchState.error = null;
		renderSearchResults();

		try {
			const api = await apiPromise;
			const results = await api.search(query);
			if (requestId !== searchRequestId) return;
			searchState.results = results;
			searchState.executedQuery = query;
			searchState.selectedResultKey = results[0] ? getResultKey(results[0], 0) : null;
			setTopMode(api.mode);
		} catch (error) {
			if (requestId !== searchRequestId) return;
			searchState.error = error instanceof Error ? error.message : String(error);
			searchState.executedQuery = query;
			searchState.results = [];
			searchState.selectedResultKey = null;
		} finally {
			if (requestId === searchRequestId) {
				searchState.loading = false;
				renderSearchResults();
			}
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
			if (!row?.dataset.resultKey) return;
			searchState.selectedResultKey = row.dataset.resultKey;
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

	const getRuleScreen = (): RuleManagementScreen => {
		if (!ruleScreen) {
			ruleScreen = createRuleManagementScreen({
				store: ruleStore,
				loadCourses: async () => {
					const api = await apiPromise;
					const summary = await api.getDashboard();
					setTopMode(api.mode);
					return summary.courses;
				},
			});
		}
		ruleScreen.activate();
		return ruleScreen;
	};

	const loadAssignments = async () => {
		if (assignmentsLoaded) return;
		try {
			const api = await apiPromise;
			assignments = await api.getDeadlines({ includePast: true });
			assignmentsLoaded = true;
			deadlineError = null;
			setTopMode(api.mode);
		} catch (error) {
			deadlineError = error instanceof Error ? error.message : String(error);
			assignmentsLoaded = false;
		}
	};

	const loadDashboard = async () => {
		if (dashboardLoaded) return;
		const cached = await readDashboardCache();
		try {
			const api = await apiPromise;
			if (api.mode === "mock" && cached) {
				dashboard = cached.dashboard;
				dashboardCachedAt = cached.cachedAt;
				dashboardUsesCache = true;
				dashboardLoaded = true;
				dashboardError = null;
				setTopMode(api.mode);
				return;
			}

			dashboard = await api.getDashboard();
			dashboardCachedAt = new Date().toISOString();
			dashboardUsesCache = false;
			dashboardLoaded = true;
			dashboardError = null;
			setTopMode(api.mode);
			await writeDashboardCache(dashboard);
		} catch (error) {
			if (cached) {
				dashboard = cached.dashboard;
				dashboardCachedAt = cached.cachedAt;
				dashboardUsesCache = true;
				dashboardLoaded = true;
				dashboardError = null;
				return;
			}
			dashboardError = error instanceof Error ? error.message : String(error);
			dashboardLoaded = false;
		}
	};

	const loadSyncSummary = async () => {
		if (syncSummaryLoaded) return;
		try {
			const api = await apiPromise;
			const syncEvent = await api.getLatestSyncEvent();
			latestSyncEvent = syncEvent;
			assignmentChanges = syncEvent ? await api.getAssignmentChanges() : [];
			syncSummaryLoaded = true;
			syncSummaryError = null;
			setTopMode(api.mode);
		} catch (error) {
			syncSummaryError = error instanceof Error ? error.message : String(error);
			syncSummaryLoaded = false;
		}
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
			const aTime = parseDueAt(a.dueAt) ?? Number.MAX_SAFE_INTEGER;
			const bTime = parseDueAt(b.dueAt) ?? Number.MAX_SAFE_INTEGER;
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
		checkbox.checked = assignment.submitted;
		checkbox.addEventListener("change", async () => {
			const submitted = checkbox.checked;
			// 応答待ちの間の二重操作を防ぐ。成否いずれも renderScreen() で
			// assignments を正本に画面を作り直すため、この checkbox 自体の状態は個別に戻さない。
			checkbox.disabled = true;
			try {
				const api = await apiPromise;
				const result = await api.updateSubmissionStatus(assignment.id, submitted);
				if (!result.ok) throw new Error("サーバーが更新を受け付けませんでした。");
				submissionError = null;
				assignments = assignments.map((item) =>
					item.id === assignment.id ? { ...item, submitted } : item,
				);
			} catch (error) {
				submissionError =
					error instanceof Error
						? `提出状態の更新に失敗しました: ${error.message}`
						: "提出状態の更新に失敗しました。";
			}
			renderScreen();
		});
		checkLabel.append(
			checkbox,
			el("span", "", assignment.submitted ? "未提出に戻す" : "提出済みにする"),
		);

		card.append(head, body, checkLabel);
		return card;
	};

	const buildSyncSummaryPanel = (): HTMLElement => {
		const panel = el("section", "fuzzy-sync-panel");
		const head = el("div", "fuzzy-sync-head");
		const titleWrap = el("div");
		titleWrap.append(el("p", "fuzzy-section-label", "データ取得通知"), el("h2", "", "取得結果"));

		const reloadButton = el("button", "fuzzy-sync-action", "表示を更新");
		reloadButton.type = "button";
		reloadButton.disabled = loadingSyncSummary;
		reloadButton.addEventListener("click", () => {
			syncSummaryLoaded = false;
			syncSummaryError = null;
			renderScreen();
		});

		head.append(titleWrap, reloadButton);
		panel.append(head);

		if (loadingSyncSummary && !syncSummaryLoaded) {
			panel.append(el("p", "fuzzy-toolbar-copy", "Moodleからのデータ取得結果を確認しています…"));
			return panel;
		}

		if (syncSummaryError) {
			const errorRow = el("div", "fuzzy-sync-error");
			errorRow.append(
				el("p", "", `データ取得結果の確認に失敗しました: ${syncSummaryError}`),
				el("p", "", "締切一覧は表示できます。変更点だけ後でもう一度確認してください。"),
			);
			panel.append(errorRow);
			return panel;
		}

		if (!latestSyncEvent) {
			panel.append(
				el("p", "fuzzy-toolbar-copy", "まだMoodleから課題・締切データを取得した記録がありません。"),
			);
			return panel;
		}

		const total = syncChangeTotal(latestSyncEvent);
		const summary = el("div", "fuzzy-sync-summary");
		const message =
			total > 0
				? `Moodleからデータを取得しました（対象${total}件）`
				: "Moodleからデータを取得しました（対象なし）";
		summary.append(
			el("p", "fuzzy-sync-message", message),
			el(
				"p",
				"fuzzy-sync-meta",
				`${formatSyncDate(latestSyncEvent.syncedAt)}・${syncTriggerLabel(latestSyncEvent.trigger)}`,
			),
		);

		const counts = el("div", "fuzzy-sync-counts");
		for (const item of [
			{ label: "新規", value: latestSyncEvent.newAssignmentCount },
			{ label: "変更", value: latestSyncEvent.changedAssignmentCount },
			{ label: "削除", value: latestSyncEvent.removedAssignmentCount },
		]) {
			const count = el("div", "fuzzy-sync-count");
			count.append(el("span", "", item.label), el("strong", "", String(item.value)));
			counts.append(count);
		}
		panel.append(summary, counts);

		const changeList = el("div", "fuzzy-change-list");
		changeList.append(
			el("p", "fuzzy-change-list-label", `変更内容（${assignmentChanges.length}件）`),
		);
		if (assignmentChanges.length === 0) {
			changeList.append(el("p", "fuzzy-toolbar-copy", "表示する変更点はありません。"));
		} else {
			for (const change of assignmentChanges) {
				const row = el("article", "fuzzy-change-row");
				const main = el("div");
				main.append(
					el("p", "fuzzy-course-name", change.courseName),
					el("h3", "", change.title),
					el("p", "fuzzy-change-field", assignmentChangeFieldLabel(change.field)),
				);

				const diff = el("div", "fuzzy-change-diff");
				diff.append(
					el(
						"span",
						"fuzzy-change-value is-old",
						assignmentChangeValueLabel(change.field, change.oldValue),
					),
					el("span", "fuzzy-change-arrow", "→"),
					el(
						"span",
						"fuzzy-change-value is-new",
						assignmentChangeValueLabel(change.field, change.newValue),
					),
				);
				row.append(main, diff);
				changeList.append(row);
			}
		}
		panel.append(changeList);
		return panel;
	};

	const buildDeadlineScreen = (): HTMLElement => {
		const screen = el("div", "fuzzy-screen");
		screen.append(buildScreenHeader("締切ハブ", "課題と提出状況をまとめて確認"));

		if (deadlineError) {
			const errorPanel = el("section", "fuzzy-error-panel");
			const retryButton = el("button", "fuzzy-primary-button", "再読み込み");
			retryButton.type = "button";
			retryButton.addEventListener("click", () => {
				deadlineError = null;
				renderScreen();
			});
			errorPanel.append(
				el("p", "", `締切データの取得に失敗しました: ${deadlineError}`),
				retryButton,
			);
			screen.append(errorPanel);
			return screen;
		}

		if (loadingDeadlines && !assignmentsLoaded) {
			screen.append(el("section", "fuzzy-placeholder", "締切データを読み込んでいます…"));
			return screen;
		}

		if (submissionError) {
			const errorPanel = el("section", "fuzzy-error-panel");
			const errorHead = el("div", "fuzzy-error-panel-head");
			const closeButton = el("button", "fuzzy-error-close", "閉じる");
			closeButton.type = "button";
			closeButton.addEventListener("click", () => {
				submissionError = null;
				renderScreen();
			});
			errorHead.append(el("p", "", submissionError), closeButton);
			errorPanel.append(errorHead);
			screen.append(errorPanel);
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

		const syncPanel = buildSyncSummaryPanel();

		const toolbar = el("section", "fuzzy-deadline-toolbar");
		const filterRow = el("div", "fuzzy-filter-row");
		for (const filter of ["all", "upcoming", "overdue", "review"] as const) {
			const button = el(
				"button",
				deadlineFilter === filter ? "fuzzy-filter-chip is-active" : "fuzzy-filter-chip",
				deadlineFilterLabel(filter),
			);
			button.type = "button";
			button.setAttribute("aria-pressed", String(deadlineFilter === filter));
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

		screen.append(metricGrid, syncPanel, toolbar, listHost);
		return screen;
	};

	const buildDashboardScreen = (): HTMLElement => {
		const screen = el("div", "fuzzy-screen");
		screen.append(buildScreenHeader("ダッシュボード", "学習状況をひと目で確認"));

		if (dashboardError) {
			const errorPanel = el("section", "fuzzy-error-panel");
			const retryButton = el("button", "fuzzy-primary-button", "再読み込み");
			retryButton.type = "button";
			retryButton.addEventListener("click", () => {
				dashboardError = null;
				renderScreen();
			});
			errorPanel.append(
				el("p", "", `ダッシュボードの取得に失敗しました: ${dashboardError}`),
				retryButton,
			);
			screen.append(errorPanel);
			return screen;
		}

		if (loadingDashboard && !dashboardLoaded) {
			screen.append(el("section", "fuzzy-placeholder", "ダッシュボードを読み込んでいます…"));
			return screen;
		}

		if (!dashboard) return screen;

		const actions = el("div", "fuzzy-dashboard-actions");
		const reloadButton = el("button", "fuzzy-primary-button", "表示を更新");
		reloadButton.type = "button";
		reloadButton.disabled = loadingDashboard;
		reloadButton.addEventListener("click", () => {
			dashboardLoaded = false;
			dashboardError = null;
			renderScreen();
		});
		actions.append(reloadButton);
		if (dashboardUsesCache) {
			actions.append(
				el(
					"p",
					"fuzzy-dashboard-cache-note",
					`オフラインキャッシュを表示中（${formatCacheDate(dashboardCachedAt ?? "")}に保存）`,
				),
			);
		} else {
			actions.append(el("p", "fuzzy-dashboard-cache-note", "最新の集計結果を表示中"));
		}

		const metrics = el("section", "fuzzy-metric-grid");
		for (const metric of [
			{ label: "保存済み資料", value: dashboard.totalFiles },
			{ label: "整理が必要", value: dashboard.totalViolations, className: "is-warn" },
			{ label: "今後の締切", value: dashboard.upcomingDeadlineCount, className: "is-soft" },
		]) {
			const card = el(
				"article",
				metric.className ? `fuzzy-metric-card ${metric.className}` : "fuzzy-metric-card",
			);
			card.append(
				el("p", "fuzzy-metric-label", metric.label),
				el("p", "fuzzy-metric-value", String(metric.value)),
			);
			metrics.append(card);
		}

		const courseList = el("section", "fuzzy-dashboard-course-list");
		if (dashboard.courses.length === 0) {
			courseList.append(el("p", "fuzzy-toolbar-copy", "表示できるコースはありません。"));
		} else {
			for (const course of dashboard.courses) {
				const card = el(
					"article",
					course.violationCount > 0 ? "fuzzy-dashboard-course is-warn" : "fuzzy-dashboard-course",
				);
				const head = el("div", "fuzzy-dashboard-course-head");
				head.append(
					el("h2", "", course.courseName),
					el("span", "fuzzy-dashboard-file-count", `${course.fileCount}資料`),
				);
				const details = el("dl", "fuzzy-dashboard-course-details");
				const addDetail = (label: string, value: string) => {
					const row = el("div");
					row.append(el("dt", "", label), el("dd", "", value));
					details.append(row);
				};
				addDetail(
					"整理状況",
					course.violationCount > 0 ? `要整理 ${course.violationCount}件` : "整理済み",
				);
				addDetail("次の締切", formatDate(course.nextDueAt));
				card.append(head, details);
				courseList.append(card);
			}
		}

		screen.append(actions, metrics, courseList);
		return screen;
	};

	const buildPlaceholderScreen = (
		screenId: Exclude<ScreenId, "search" | "dashboard" | "rules">,
	): HTMLElement => {
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
		} else if (activeScreen === "dashboard") {
			if (!dashboardLoaded && !loadingDashboard && !dashboardError) {
				loadingDashboard = true;
				void loadDashboard().finally(() => {
					loadingDashboard = false;
					if (activeScreen === "dashboard") renderScreen();
				});
			}
			mainEl.replaceChildren(buildDashboardScreen());
		} else if (activeScreen === "deadlines") {
			// 先にロード状態を確定させてから描画する。順序を逆にすると初回描画時点では
			// loadingDeadlines がまだ false のため、読み込み中に空状態がちらついてしまう。
			if (!assignmentsLoaded && !loadingDeadlines && !deadlineError) {
				loadingDeadlines = true;
				void loadAssignments().finally(() => {
					loadingDeadlines = false;
					if (activeScreen === "deadlines") renderScreen();
				});
			}
			if (!syncSummaryLoaded && !loadingSyncSummary && !syncSummaryError) {
				loadingSyncSummary = true;
				void loadSyncSummary().finally(() => {
					loadingSyncSummary = false;
					if (activeScreen === "deadlines") renderScreen();
				});
			}
			mainEl.replaceChildren(buildDeadlineScreen());
		} else if (activeScreen === "rules") {
			mainEl.replaceChildren(getRuleScreen().root);
		} else {
			mainEl.replaceChildren(buildPlaceholderScreen(activeScreen));
		}
	};

	const closeShell = () => {
		if (!isOpen) return;
		isOpen = false;
		renderEntryState();
		window.removeEventListener("resize", applyShellFrame);
		page?.remove();
		restoreMainContent();
		document.body.classList.remove("fuzzy-shell-open");
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
		footer.append(el("p", "", "開発中"), el("span", "", "issue55 + issue56 + issue57"));
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
		renderEntryState();
		document.body.classList.add("fuzzy-shell-open");
		shellTopOffset = getShellTopOffset(navHost);
		moveMainContentToStash();
		document.body.append(buildPage());
		applyShellFrame();
		window.addEventListener("resize", applyShellFrame);

		// 接続モードの表示だけ非同期で更新する（検索は自動では実行しない）
		void apiPromise.then(
			(api) => setTopMode(api.mode),
			() => setTopMode("checking"),
		);

		if (activeScreen === "search") {
			getSearchScreen().input.focus();
		}
	};

	navButton.addEventListener("click", (event) => {
		event.preventDefault();
		if (isOpen) closeShell();
		else openShell();
	});

	ensureDrawerEntry();
	new MutationObserver(() => ensureDrawerEntry()).observe(document.body, {
		childList: true,
		subtree: true,
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

function insertNavRoot(navHost: HTMLElement, root: HTMLElement): void {
	const moreItem = Array.from(navHost.children).find((child) => {
		if (!(child instanceof HTMLElement)) return false;
		const text = child.textContent?.trim() ?? "";
		return text.includes("さらに") || text.includes("More");
	});

	if (moreItem) {
		navHost.insertBefore(root, moreItem);
	} else {
		navHost.append(root);
	}

	window.dispatchEvent(new Event("resize"));
}

function findDrawerMyCoursesLink(): HTMLAnchorElement | null {
	return (
		Array.from(document.querySelectorAll<HTMLAnchorElement>("a.list-group-item")).find((link) => {
			const href = link.getAttribute("href") ?? "";
			const text = link.textContent?.trim() ?? "";
			return (
				(href.includes("/my/courses.php") || text === "マイコース" || text === "My courses") &&
				!link.classList.contains("sr-only") &&
				!link.classList.contains("skip")
			);
		}) ?? null
	);
}

function upsertDrawerButton(): HTMLAnchorElement | null {
	const existing = document.getElementById(DRAWER_BUTTON_ID);
	if (existing instanceof HTMLAnchorElement) return existing;

	const myCoursesLink = findDrawerMyCoursesLink();
	if (!myCoursesLink) return null;

	const button = document.createElement("a");
	button.id = DRAWER_BUTTON_ID;
	button.href = "#";
	button.className = "list-group-item list-group-item-action fuzzy-drawer-button";
	button.textContent = "Fuzzy";
	myCoursesLink.insertAdjacentElement("afterend", button);
	return button;
}

function getShellTopOffset(navHost: HTMLElement): number {
	const candidates = [
		navHost.closest<HTMLElement>("header"),
		navHost.closest<HTMLElement>(".primary-navigation"),
		navHost.closest<HTMLElement>(".secondary-navigation"),
		navHost.closest<HTMLElement>(".moremenu"),
		document.querySelector<HTMLElement>("header[role='banner']"),
		document.querySelector<HTMLElement>(".navbar"),
		document.querySelector<HTMLElement>(".primary-navigation"),
		document.querySelector<HTMLElement>(".secondary-navigation"),
		document.querySelector<HTMLElement>(".tertiary-navigation"),
		document.querySelector<HTMLElement>(".nav-tabs"),
		document.querySelector<HTMLElement>(".tabs"),
		document.querySelector<HTMLElement>(".moremenu"),
		document.querySelector<HTMLElement>(".secondarymoremenu"),
		document.querySelector<HTMLElement>("#page-header"),
		document.querySelector<HTMLElement>(".page-header-headings"),
	];

	const bottoms = candidates
		.filter((element): element is HTMLElement => element !== null)
		.map((element) => element.getBoundingClientRect().bottom)
		.filter((bottom) => Number.isFinite(bottom) && bottom > 0);

	if (bottoms.length === 0) {
		return Math.max(0, Math.round(navHost.getBoundingClientRect().bottom));
	}

	return Math.max(0, Math.round(Math.max(...bottoms)));
}

function ensureStyle(): void {
	if (document.getElementById(STYLE_ID)) return;

	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
		body.fuzzy-shell-open {
			overflow: hidden;
		}

		body.fuzzy-shell-open #page-header,
		body.fuzzy-shell-open .page-header-headings,
		body.fuzzy-shell-open .page-context-header,
		body.fuzzy-shell-open #page-navbar,
		body.fuzzy-shell-open #page-secondary-navigation,
		body.fuzzy-shell-open .secondary-navigation,
		body.fuzzy-shell-open .tertiary-navigation,
		body.fuzzy-shell-open .course-navigation,
		body.fuzzy-shell-open .course-header {
			display: none !important;
		}

		#${ROOT_ID} {
			margin-left: 8px;
		}

		.fuzzy-nav-button {
			display: inline-flex;
			align-items: center;
			gap: 10px;
			border-bottom: 3px solid transparent;
			padding: 12px 16px 10px;
			font-family: "Yu Gothic UI", "Hiragino Sans", "Meiryo", sans-serif;
			font-weight: 700;
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
			position: fixed;
			left: 0;
			right: 0;
			bottom: 0;
			z-index: 2147483000;
			display: grid;
			grid-template-columns: 180px minmax(0, 1fr);
			min-height: 0;
			overflow: hidden;
			background:
				radial-gradient(circle at top left, rgba(108, 99, 255, 0.12), transparent 22%),
				linear-gradient(180deg, #eef1ff 0%, #f7f8ff 100%);
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
			display: grid;
			grid-template-rows: auto 1fr;
			gap: 12px;
			padding: 24px 28px 32px;
			overflow: auto;
		}

		.fuzzy-topbar {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 16px;
			width: 100%;
			max-width: 1320px;
			margin: 0 auto;
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

		.fuzzy-main {
			max-width: 1320px;
			width: 100%;
			margin: 0 auto;
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

		.fuzzy-dashboard-actions {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 14px;
			padding: 14px;
			border-radius: 14px;
			background: #ffffff;
			box-shadow: 0 10px 28px rgba(58, 69, 120, 0.08);
		}

		.fuzzy-dashboard-cache-note {
			margin: 0;
			color: #636b8b;
			font-size: 0.8rem;
			font-weight: 800;
			line-height: 1.6;
			text-align: right;
		}

		.fuzzy-dashboard-course-list {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 14px;
		}

		.fuzzy-dashboard-course {
			display: grid;
			gap: 16px;
			padding: 16px;
			border-radius: 14px;
			background: #ffffff;
			box-shadow: 0 10px 28px rgba(58, 69, 120, 0.08);
		}

		.fuzzy-dashboard-course.is-warn {
			box-shadow:
				inset 4px 0 0 #f2bd41,
				0 10px 28px rgba(58, 69, 120, 0.08);
		}

		.fuzzy-dashboard-course-head {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 12px;
		}

		.fuzzy-dashboard-course-head h2 {
			margin: 0;
			font-size: 1.05rem;
			font-weight: 900;
		}

		.fuzzy-dashboard-file-count {
			flex: 0 0 auto;
			border-radius: 999px;
			padding: 6px 10px;
			background: #eef0fb;
			color: #5b61a0;
			font-size: 0.74rem;
			font-weight: 900;
		}

		.fuzzy-dashboard-course-details {
			display: grid;
			gap: 10px;
			margin: 0;
		}

		.fuzzy-dashboard-course-details div {
			display: grid;
			grid-template-columns: 74px 1fr;
			gap: 10px;
		}

		.fuzzy-dashboard-course-details dt {
			color: #7a81a1;
			font-size: 0.76rem;
			font-weight: 800;
		}

		.fuzzy-dashboard-course-details dd {
			margin: 0;
			font-size: 0.86rem;
			font-weight: 800;
		}

		.fuzzy-sync-panel {
			display: grid;
			gap: 14px;
			padding: 16px;
			border-radius: 14px;
			background:
				linear-gradient(145deg, rgba(108, 99, 255, 0.12), transparent 48%),
				#ffffff;
			box-shadow: 0 10px 28px rgba(58, 69, 120, 0.08);
		}

		.fuzzy-sync-head {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 14px;
		}

		.fuzzy-sync-head h2,
		.fuzzy-change-row h3,
		.fuzzy-sync-message,
		.fuzzy-sync-meta,
		.fuzzy-change-field,
		.fuzzy-sync-error p {
			margin: 0;
		}

		.fuzzy-sync-head h2 {
			font-size: 1.18rem;
			font-weight: 900;
		}

		.fuzzy-sync-action {
			border: 0;
			border-radius: 999px;
			padding: 8px 12px;
			background: #eef0fb;
			color: #59607d;
			font: inherit;
			font-size: 0.78rem;
			font-weight: 800;
			cursor: pointer;
			white-space: nowrap;
		}

		.fuzzy-sync-action:disabled {
			cursor: wait;
			opacity: 0.7;
		}

		.fuzzy-sync-summary {
			display: grid;
			gap: 4px;
		}

		.fuzzy-sync-message {
			font-size: 1rem;
			font-weight: 900;
		}

		.fuzzy-sync-meta,
		.fuzzy-change-field {
			color: #636b8b;
			font-size: 0.8rem;
			font-weight: 800;
		}

		.fuzzy-sync-counts {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 10px;
		}

		.fuzzy-sync-count {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 10px;
			border-radius: 12px;
			padding: 10px 12px;
			background: rgba(255, 255, 255, 0.72);
			box-shadow: inset 0 0 0 1px #eceefd;
			color: #636b8b;
			font-size: 0.8rem;
			font-weight: 800;
		}

		.fuzzy-sync-count strong {
			color: #151515;
			font-size: 1.2rem;
			font-weight: 900;
		}

		.fuzzy-change-list {
			display: grid;
			gap: 10px;
		}

		.fuzzy-change-list-label {
			margin: 0;
			color: #636b8b;
			font-size: 0.8rem;
			font-weight: 800;
		}

		.fuzzy-change-row {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(220px, 0.75fr);
			gap: 14px;
			align-items: center;
			border-radius: 12px;
			padding: 12px;
			background: #ffffff;
			box-shadow: inset 0 0 0 1px #eceefd;
		}

		.fuzzy-change-row h3 {
			font-size: 0.96rem;
			font-weight: 900;
		}

		.fuzzy-change-diff {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
			gap: 8px;
			align-items: center;
		}

		.fuzzy-change-value {
			border-radius: 10px;
			padding: 8px 10px;
			background: #f4f5fb;
			font-size: 0.78rem;
			font-weight: 800;
			line-height: 1.5;
		}

		.fuzzy-change-value.is-new {
			background: #dcf9e8;
			color: #14935b;
		}

		.fuzzy-change-arrow {
			color: #6c63ff;
			font-weight: 900;
		}

		.fuzzy-sync-error {
			display: grid;
			gap: 6px;
			border-radius: 12px;
			padding: 12px;
			background: #fff0ec;
			color: #b43d24;
			font-size: 0.86rem;
			font-weight: 800;
			line-height: 1.7;
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

		.fuzzy-error-panel {
			padding: 16px;
			border-radius: 14px;
			background: #fff0ec;
			color: #b43d24;
			box-shadow: 0 10px 28px rgba(58, 69, 120, 0.08);
			font-size: 0.9rem;
			font-weight: 800;
			line-height: 1.7;
		}

		.fuzzy-error-panel-head {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 12px;
		}

		.fuzzy-error-panel-head p {
			margin: 0;
		}

		.fuzzy-error-close {
			border: 0;
			border-radius: 999px;
			padding: 6px 12px;
			background: rgba(180, 61, 36, 0.12);
			color: #b43d24;
			font: inherit;
			font-size: 0.78rem;
			font-weight: 800;
			cursor: pointer;
			flex: 0 0 auto;
		}

		.fuzzy-nav-button:focus,
		.fuzzy-side-link:focus,
		.fuzzy-close-button:focus,
		.fuzzy-primary-button:focus,
		.fuzzy-sync-action:focus,
		.fuzzy-error-close:focus,
		.fuzzy-result-row:focus,
		.fuzzy-filter-chip:focus,
		.fuzzy-checkline input:focus,
		.fuzzy-search-input-wrap:focus-within {
			outline: 3px solid rgba(108, 99, 255, 0.28);
			outline-offset: 2px;
		}

		@media (max-width: 1080px) {
			#${PAGE_ID} {
				grid-template-columns: 92px minmax(0, 1fr);
			}

			.fuzzy-sidebar {
				grid-template-rows: auto 1fr;
				gap: 18px;
				padding: 14px 10px;
			}

			.fuzzy-side-nav {
				gap: 10px;
			}

			.fuzzy-side-link {
				display: grid;
				justify-items: center;
				gap: 6px;
				border-radius: 12px;
				padding: 10px 6px;
				font-size: 0.68rem;
				line-height: 1.25;
				text-align: center;
			}

			.fuzzy-sidebar-footer {
				display: none;
			}

			.fuzzy-brand {
				justify-content: center;
			}

			.fuzzy-brand span:last-child {
				display: none;
			}

			.fuzzy-side-dot {
				width: 10px;
				height: 10px;
			}

			.fuzzy-content {
				min-height: 0;
				padding: 18px 18px 24px;
			}

			.fuzzy-search-layout {
				grid-template-columns: 1fr;
			}

			.fuzzy-metric-grid {
				grid-template-columns: 1fr;
			}

			.fuzzy-dashboard-course-list,
			.fuzzy-sync-counts,
			.fuzzy-change-row {
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

			.fuzzy-dashboard-actions {
				align-items: flex-start;
				flex-direction: column;
			}

			.fuzzy-dashboard-cache-note {
				text-align: left;
			}
		}
	`;

	document.head.append(style);
}
