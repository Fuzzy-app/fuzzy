// Fuzzyシェル本体（issue54: 横断検索UIの土台）。
// Moodleの上部ナビに「Fuzzy」タブを追加し、開くと本文領域をFuzzyの画面
// （左サイドバー＋各機能画面）へ差し替える。閉じると元のMoodle本文を復元する。
//
// 【XSS対策の方針】
// ファイル名・スニペット・授業名などの動的な文字列は、Moodleから保存した資料に
// 由来する「外部データ」なので信用しない。DOMへ入れる際は必ず textContent /
// dataset を経由し、HTML文字列の組み立て（innerHTML等）には一切混ぜないこと。
// このモジュールでは動的データを含むHTML文字列を組み立てる箇所を意図的に無くしている。

import type { DashboardSummary, FuzzyApiClient, PresentationState } from "@fuzzy/shared";
import { BackgroundApiClient } from "../../lib/api/backgroundApi";
import { readDashboardCacheFromBackground } from "../../lib/cache/dashboardCacheMessaging";
import {
	type DeadlineScreenNavigationMessage,
	PENDING_SYNC_SCREEN_NAVIGATION_KEY,
	isDeadlineScreenNavigation,
} from "../../lib/notifications/syncNotificationNavigation";
import { createRuleManagementStore } from "../../lib/rules/state";
import { FUZZY_SCREENS, FUZZY_SCREEN_ORDER, type FuzzyScreenId } from "../../lib/ui/screenCopy";
import { buildDashboardScreen } from "./dashboardScreen";
import { DeadlineScreenController } from "./deadlineScreen";
import { type RuleManagementScreen, createRuleManagementScreen } from "./rulesScreen";
import { SearchScreenController } from "./searchScreen";
import { createBrandIcon, shellElement as el } from "./shellElements";
import {
	findMainHost,
	findNavHost,
	getShellTopOffset,
	insertNavRoot,
	upsertDrawerButton,
} from "./shellHost";
import { SHELL_NAV_BUTTON_ID, SHELL_PAGE_ID, SHELL_ROOT_ID, SHELL_STASH_ID } from "./shellIds";
import { ensureShellStyle } from "./shellStyle";

type ConnectionMode = FuzzyApiClient["mode"] | "checking";
type ScreenId = FuzzyScreenId;
export const FUZZY_SHELL_VISIBILITY_EVENT = "fuzzy:shell-visibility";

const menuItems = FUZZY_SCREEN_ORDER.map((id) => ({
	id,
	label: FUZZY_SCREENS[id].navigationLabel,
	description: FUZZY_SCREENS[id].description,
}));

export function mountFuzzyShell(): void {
	if (document.getElementById(SHELL_ROOT_ID)) return;

	const navHost = findNavHost();
	const mainHost = findMainHost();
	if (!navHost || !mainHost) {
		console.warn("[fuzzy] ナビゲーションまたは本文領域が見つかりませんでした");
		return;
	}

	ensureShellStyle();

	// Moodleの自動折りたたみ処理に乗せるため、既存タブと同じ li.nav-item > a.nav-link で追加する。
	const navButton = el("a", "nav-link fuzzy-nav-button");
	navButton.id = SHELL_NAV_BUTTON_ID;
	navButton.href = "#";
	navButton.setAttribute("aria-pressed", "false");
	navButton.append(createBrandIcon("fuzzy-nav-mark"), el("span", "", "Fuzzy"));

	const root = el(
		navHost.tagName === "UL" ? "li" : "div",
		navHost.tagName === "UL" ? "nav-item" : "",
	);
	root.id = SHELL_ROOT_ID;
	root.append(navButton);
	insertNavRoot(navHost, root);

	// シェルを開いている間、Moodle本文の退避先になる要素
	const stash = el("div");
	stash.id = SHELL_STASH_ID;
	stash.hidden = true;
	mainHost.after(stash);

	// --- 状態 ---
	const apiPromise = Promise.resolve(new BackgroundApiClient());
	const ruleStore = createRuleManagementStore();
	let page: HTMLElement | null = null;
	let mainEl: HTMLElement | null = null;
	let statusBadge: HTMLElement | null = null;
	let searchScreen: SearchScreenController | null = null;
	let deadlineScreen: DeadlineScreenController | null = null;
	let ruleScreen: RuleManagementScreen | null = null;
	let drawerButton: HTMLAnchorElement | null = null;
	const sideLinks: HTMLButtonElement[] = [];
	let isOpen = false;
	let activeScreen: ScreenId = "search";
	let mode: ConnectionMode = "checking";
	let shellTopOffset = 0;
	let dashboard: DashboardSummary | null = null;
	let dashboardCachedAt: string | null = null;
	let dashboardUsesCache = false;
	let dashboardPresentation: PresentationState = {
		tone: "loading",
		title: "整理状況を読み込んでいます…",
	};
	let dashboardLoad: Promise<void> | null = null;

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
				? "このPCのデータを表示中"
				: mode === "mock"
					? "サンプルデータを表示中"
					: "表示する情報を確認中";
	};

	const setTopModeFromApi = (api: {
		readonly mode: FuzzyApiClient["mode"] | "unknown";
	}) => {
		if (api.mode !== "unknown") setTopMode(api.mode);
	};

	const applyShellFrame = (measuredTopOffset?: number) => {
		if (!page) return;
		shellTopOffset = measuredTopOffset ?? getShellTopOffset(navHost);
		page.style.top = `${shellTopOffset}px`;
		page.style.height = `calc(100vh - ${shellTopOffset}px)`;
	};
	const handleShellResize = () => applyShellFrame();

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

	const getSearchScreen = (): SearchScreenController => {
		searchScreen ??= new SearchScreenController({
			api: apiPromise,
			onApiReady: setTopModeFromApi,
		});
		return searchScreen;
	};

	const getDeadlineScreen = (): DeadlineScreenController => {
		deadlineScreen ??= new DeadlineScreenController({
			api: apiPromise,
			onApiReady: setTopModeFromApi,
			onChange: () => {
				if (activeScreen === "deadlines") renderScreen();
			},
		});
		return deadlineScreen;
	};

	const getRuleScreen = (): RuleManagementScreen => {
		if (!ruleScreen) {
			ruleScreen = createRuleManagementScreen({
				store: ruleStore,
				loadCourses: async () => {
					const api = await apiPromise;
					const summary = await api.getDashboard();
					setTopModeFromApi(api);
					return summary.courses;
				},
			});
		}
		ruleScreen.activate();
		return ruleScreen;
	};

	const loadDashboard = async () => {
		const cached = await readDashboardCacheFromBackground().catch((error) => {
			console.warn("[fuzzy] backgroundからダッシュボードキャッシュを取得できませんでした", error);
			return null;
		});
		try {
			const api = await apiPromise;
			const latestDashboard = await api.getDashboard();
			setTopModeFromApi(api);
			if (api.mode === "mock") {
				if (!cached) {
					dashboard = null;
					dashboardPresentation = {
						tone: "empty",
						title: "表示できる情報がありません",
						impact: "Moodleを開いた状態で、もう一度お試しください。",
					};
					return;
				}
				dashboard = cached.dashboard;
				dashboardCachedAt = cached.cachedAt;
				dashboardUsesCache = true;
				dashboardPresentation = {
					tone: "warning",
					title: "前回保存した整理状況を表示しています",
				};
				return;
			}

			dashboard = latestDashboard;
			dashboardCachedAt = new Date().toISOString();
			dashboardUsesCache = false;
			dashboardPresentation = { tone: "ready", title: "最新の整理状況です" };
		} catch (error) {
			console.warn("[fuzzy] 整理状況の取得に失敗しました", error);
			if (cached) {
				dashboard = cached.dashboard;
				dashboardCachedAt = cached.cachedAt;
				dashboardUsesCache = true;
				dashboardPresentation = {
					tone: "warning",
					title: "前回保存した整理状況を表示しています",
					impact: "最新情報は取得できませんでした。",
					technicalDetails: error instanceof Error ? error.message : String(error),
				};
				return;
			}
			dashboard = null;
			dashboardPresentation = {
				tone: "error",
				title: "整理状況を読み込めませんでした。",
				impact: "時間をおいて再度お試しください。",
				technicalDetails: error instanceof Error ? error.message : String(error),
			};
		}
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
			if (dashboardPresentation.tone === "loading" && !dashboardLoad) {
				dashboardLoad = loadDashboard().finally(() => {
					dashboardLoad = null;
					if (activeScreen === "dashboard") renderScreen();
				});
			}
			mainEl.replaceChildren(
				buildDashboardScreen(
					{
						dashboard,
						presentation: dashboardPresentation,
						cachedAt: dashboardCachedAt,
						usesCache: dashboardUsesCache,
					},
					{
						reload: () => {
							dashboardPresentation = {
								tone: "loading",
								title: "整理状況を読み込んでいます…",
							};
							renderScreen();
						},
						openDeadlines: () => {
							activeScreen = "deadlines";
							renderScreen();
						},
					},
				),
			);
		} else if (activeScreen === "deadlines") {
			mainEl.replaceChildren(getDeadlineScreen().render());
		} else if (activeScreen === "rules") {
			mainEl.replaceChildren(getRuleScreen().root);
		}
	};

	const closeShell = () => {
		if (!isOpen) return;
		isOpen = false;
		window.dispatchEvent(
			new CustomEvent(FUZZY_SHELL_VISIBILITY_EVENT, { detail: { open: false } }),
		);
		renderEntryState();
		window.removeEventListener("resize", handleShellResize);
		page?.remove();
		restoreMainContent();
		document.body.classList.remove("fuzzy-shell-open");
	};

	const buildPage = (): HTMLElement => {
		if (page) return page;

		page = el("section", "fuzzy-shell");
		page.id = SHELL_PAGE_ID;

		const sidebar = el("div", "fuzzy-sidebar");
		const brand = el("div", "fuzzy-brand");
		brand.append(createBrandIcon("fuzzy-brand-mark"), el("span", "", "Fuzzy"));

		const nav = el("nav", "fuzzy-side-nav");
		nav.setAttribute("aria-label", "Fuzzy menu");
		for (const item of menuItems) {
			const link = el("button", "fuzzy-side-link");
			link.type = "button";
			link.dataset.screen = item.id;
			link.title = item.description;
			link.append(el("span", "fuzzy-side-dot"), el("span", "fuzzy-side-label", item.label));
			link.addEventListener("click", () => {
				activeScreen = item.id;
				renderScreen();
			});
			sideLinks.push(link);
			nav.append(link);
		}

		sidebar.append(brand, nav);

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
		window.dispatchEvent(new CustomEvent(FUZZY_SHELL_VISIBILITY_EVENT, { detail: { open: true } }));
		renderEntryState();
		// Measure Moodle's header before the shell's compacting rules hide page content.
		const initialShellTopOffset = getShellTopOffset(navHost);
		document.body.classList.add("fuzzy-shell-open");
		moveMainContentToStash();
		document.body.append(buildPage());
		applyShellFrame(initialShellTopOffset);
		window.addEventListener("resize", handleShellResize);

		// 接続モードの表示だけ非同期で更新する（検索は自動では実行しない）
		void apiPromise.then(
			(api) => setTopModeFromApi(api),
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

	const applyDeadlineNavigation = (message: DeadlineScreenNavigationMessage) => {
		getDeadlineScreen().openSyncEvent(message.syncEventId);
		activeScreen = "deadlines";
		if (!isOpen) openShell();
		else renderScreen();
	};

	browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
		if (!isDeadlineScreenNavigation(message)) return false;
		applyDeadlineNavigation(message);
		sendResponse({ handled: true });
		return false;
	});

	void browser.storage.local
		.get(PENDING_SYNC_SCREEN_NAVIGATION_KEY)
		.then(async (stored) => {
			const pending = stored[PENDING_SYNC_SCREEN_NAVIGATION_KEY];
			if (!isDeadlineScreenNavigation(pending)) return;
			applyDeadlineNavigation(pending);
			await browser.storage.local.remove(PENDING_SYNC_SCREEN_NAVIGATION_KEY);
		})
		.catch((error) => {
			console.warn("[fuzzy] 通知からの画面遷移を復元できませんでした", error);
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
