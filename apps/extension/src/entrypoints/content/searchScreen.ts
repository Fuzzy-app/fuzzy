import type { FuzzyApiClient, PresentationState, SearchResult } from "@fuzzy/shared";
import {
	buildShellScreenHeader,
	shellElement as el,
	fileKindClass,
	fileKindLabel,
} from "./shellElements";

interface SearchScreenOptions {
	api: Promise<
		Pick<FuzzyApiClient, "search"> & {
			readonly mode: FuzzyApiClient["mode"] | "unknown";
		}
	>;
	onApiReady: (api: { readonly mode: FuzzyApiClient["mode"] | "unknown" }) => void;
}

interface SearchModel {
	query: string;
	executedQuery: string;
	results: SearchResult[];
	selectedResultKey: string | null;
	presentation: PresentationState;
}

const INITIAL_PRESENTATION: PresentationState = {
	tone: "empty",
	title: "まだ結果がありません",
	impact: "キーワードを入力してください",
};

export class SearchScreenController {
	readonly root: HTMLElement;
	readonly input: HTMLInputElement;

	readonly #options: SearchScreenOptions;
	readonly #submitButton: HTMLButtonElement;
	readonly #countLabel: HTMLElement;
	readonly #resultsHost: HTMLElement;
	readonly #noteHost: HTMLElement;
	#requestId = 0;
	#model: SearchModel = {
		query: "",
		executedQuery: "",
		results: [],
		selectedResultKey: null,
		presentation: INITIAL_PRESENTATION,
	};

	constructor(options: SearchScreenOptions) {
		this.#options = options;
		const screen = el("div", "fuzzy-screen");
		screen.append(buildShellScreenHeader("search"));

		const panel = el("section", "fuzzy-search-panel");
		const form = el("form", "fuzzy-search-form");
		const inputWrap = el("div", "fuzzy-search-input-wrap");
		this.input = el("input");
		this.input.id = "fuzzy-search-input";
		this.input.type = "search";
		this.input.setAttribute("aria-label", "検索キーワード");
		this.input.placeholder = "調べたい単語を入力";
		inputWrap.append(el("span", "fuzzy-search-dot"), this.input);
		this.#submitButton = el("button", "fuzzy-primary-button", "検索");
		this.#submitButton.type = "submit";
		form.append(inputWrap, this.#submitButton);

		const meta = el("div", "fuzzy-search-meta");
		this.#countLabel = el("p");
		meta.append(this.#countLabel);
		panel.append(form, meta);

		const layout = el("section", "fuzzy-search-layout");
		this.#resultsHost = el("div", "fuzzy-search-results");
		this.#noteHost = el("div", "fuzzy-search-note");
		layout.append(this.#resultsHost, this.#noteHost);
		screen.append(panel, layout);
		this.root = screen;

		this.input.addEventListener("input", () => {
			this.#model.query = this.input.value;
		});
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			void this.#runSearch();
		});
		this.#resultsHost.addEventListener("click", (event) => {
			if (!(event.target instanceof Element)) return;
			const row = event.target.closest<HTMLButtonElement>(".fuzzy-result-row");
			if (!row?.dataset.resultKey) return;
			this.#model.selectedResultKey = row.dataset.resultKey;
			this.#renderSelection();
		});
		this.#render();
	}

	#resultKey(result: SearchResult, index: number): string {
		return `${result.fileId}:${result.page ?? "none"}:${index}`;
	}

	#formatPage(result: SearchResult, compact = false): string {
		if (result.page === null) return compact ? "—" : "ページ情報なし";
		if (result.pageCount === null) return compact ? `p.${result.page}` : `${result.page}ページ`;
		return compact
			? `p.${result.page} / ${result.pageCount}`
			: `${result.page} / ${result.pageCount}ページ`;
	}

	#createResultRow(result: SearchResult, index: number): HTMLButtonElement {
		const row = el("button", "fuzzy-result-row");
		row.type = "button";
		row.dataset.resultKey = this.#resultKey(result, index);

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
		side.append(el("p", "", this.#formatPage(result, true)), el("span", "", "詳細を見る"));
		row.append(kind, main, el("p", "fuzzy-result-snippet", result.snippet), side);
		return row;
	}

	#renderSelection(): void {
		const selected =
			this.#model.results.find(
				(result, index) => this.#resultKey(result, index) === this.#model.selectedResultKey,
			) ?? null;
		for (const row of this.#resultsHost.querySelectorAll<HTMLButtonElement>(".fuzzy-result-row")) {
			row.classList.toggle(
				"is-selected",
				selected !== null && row.dataset.resultKey === this.#model.selectedResultKey,
			);
		}
		if (!selected) {
			this.#noteHost.replaceChildren(
				el("p", "fuzzy-section-label", "検索のメモ"),
				el("h2", "", "資料の所在を見つける"),
				el(
					"p",
					"fuzzy-note-copy",
					"該当部分には、検索した言葉の前後を短く抜き出して表示します。まずは「正規化」で確認できます。",
				),
			);
			return;
		}

		const grid = el("dl", "fuzzy-note-grid");
		for (const [term, detail] of [
			["授業", selected.courseName ?? "未設定"],
			["ページ", this.#formatPage(selected)],
			["関連度", `${Math.round(selected.score * 100)}%`],
		]) {
			const row = el("div");
			row.append(el("dt", "", term), el("dd", "", detail));
			grid.append(row);
		}
		this.#noteHost.replaceChildren(
			el("p", "fuzzy-section-label", "選択中の資料"),
			el("h2", "", selected.fileName),
			el(
				"p",
				"fuzzy-note-copy",
				selected.page === null
					? "該当箇所を見つけました。ページ情報は未登録です。"
					: `${this.#formatPage(selected)}付近に該当箇所があります。`,
			),
			grid,
		);
	}

	#render(): void {
		const { presentation, executedQuery, results } = this.#model;
		const loading = presentation.tone === "loading";
		this.#submitButton.textContent = loading ? "検索中…" : "検索";
		this.#submitButton.disabled = loading;
		this.#countLabel.textContent = executedQuery
			? `「${executedQuery}」に一致: ${results.length}ファイル`
			: (presentation.impact ?? presentation.title);

		if (presentation.tone === "error") {
			this.#resultsHost.replaceChildren(el("p", "fuzzy-error", presentation.title));
		} else if (loading) {
			this.#resultsHost.replaceChildren(el("p", "fuzzy-loading", presentation.title));
		} else if (results.length === 0) {
			const empty = el("section", "fuzzy-empty");
			empty.append(
				el("h2", "", presentation.title),
				el("p", "", presentation.impact ?? "サンプルでは「正規化」で結果が表示されます。"),
			);
			this.#resultsHost.replaceChildren(empty);
		} else {
			const list = el("div", "fuzzy-result-list");
			list.append(...results.map((result, index) => this.#createResultRow(result, index)));
			this.#resultsHost.replaceChildren(
				el("p", "fuzzy-section-label", "該当箇所順（関連が高い順）"),
				list,
			);
		}
		this.#renderSelection();
	}

	async #runSearch(): Promise<void> {
		const requestId = ++this.#requestId;
		const query = this.#model.query.trim();
		if (!query) {
			this.#model = {
				...this.#model,
				executedQuery: "",
				results: [],
				selectedResultKey: null,
				presentation: {
					tone: "warning",
					title: "検索したいワードを入力してください。",
				},
			};
			this.#render();
			return;
		}

		this.#model.presentation = { tone: "loading", title: "検索中…" };
		this.#render();
		try {
			const api = await this.#options.api;
			const results = await api.search(query);
			if (requestId !== this.#requestId) return;
			this.#model = {
				query: this.#model.query,
				executedQuery: query,
				results,
				selectedResultKey: results[0] ? this.#resultKey(results[0], 0) : null,
				presentation:
					results.length > 0
						? { tone: "ready", title: "検索結果を表示しました" }
						: {
								tone: "empty",
								title: "一致する資料がありません",
								impact: "別のキーワードでも試してください。",
							},
			};
			this.#options.onApiReady(api);
		} catch (error) {
			if (requestId !== this.#requestId) return;
			console.warn("[fuzzy] 資料検索に失敗しました", error);
			this.#model = {
				...this.#model,
				executedQuery: query,
				results: [],
				selectedResultKey: null,
				presentation: {
					tone: "error",
					title: "資料を検索できませんでした。時間をおいて再度お試しください。",
					technicalDetails: error instanceof Error ? error.message : String(error),
				},
			};
		}
		this.#render();
	}
}
