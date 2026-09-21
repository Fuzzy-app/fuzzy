import { buildSearchQueryVariants, normalizeSearchText } from "@fuzzy/shared";
import type {
	CourseDashboardEntry,
	FuzzyApiClient,
	PresentationState,
	SearchResult,
	SearchScope,
} from "@fuzzy/shared";
import { boundedParallelMap } from "../../lib/boundedParallelMap";
import { groupCourses } from "./courseHierarchy";
import {
	buildShellScreenHeader,
	shellElement as el,
	fileKindClass,
	fileKindLabel,
} from "./shellElements";

interface SearchScreenOptions {
	api: Promise<
		Pick<FuzzyApiClient, "search" | "openFile"> &
			Partial<Pick<FuzzyApiClient, "getDashboard">> & {
				readonly mode: FuzzyApiClient["mode"] | "unknown";
			}
	>;
	onApiReady: (api: { readonly mode: FuzzyApiClient["mode"] | "unknown" }) => void;
}

interface SearchModel {
	query: string;
	courseIds: number[];
	folder: string;
	executedQuery: string;
	results: SearchPresentationResult[];
	selectedResultKey: string | null;
	presentation: PresentationState;
}

export interface SearchPresentationResult extends SearchResult {
	exactMatchCount: number;
	similarMatchCount: number;
}

const INITIAL_PRESENTATION: PresentationState = {
	tone: "empty",
	title: "まだ結果がありません",
	impact: "キーワードを入力してください",
};

interface SearchAggregate {
	result: SearchPresentationResult;
	exactMatchCount: number;
	similarMatchCount: number;
	score: number;
	seenLocations: Set<string>;
}

function isExactSearchMatch(query: string, result: SearchResult): boolean {
	const normalizedQuery = normalizeSearchText(query);
	return normalizeSearchText(result.snippet).includes(normalizedQuery);
}

/** 同一ファイルの複数ページ・複数箇所を、1つの資料結果へまとめる。 */
export function aggregateSearchResults(
	results: readonly SearchResult[],
	query: string,
): SearchPresentationResult[] {
	const aggregates = new Map<number, SearchAggregate>();
	for (const result of results) {
		const locationKey = `${result.fileId}:${result.page ?? "document"}`;
		const exact = isExactSearchMatch(query, result);
		const existing = aggregates.get(result.fileId);
		if (!existing) {
			aggregates.set(result.fileId, {
				result: { ...result, exactMatchCount: exact ? 1 : 0, similarMatchCount: exact ? 0 : 1 },
				exactMatchCount: exact ? 1 : 0,
				similarMatchCount: exact ? 0 : 1,
				score: Number.isFinite(result.score) ? result.score : 0,
				seenLocations: new Set([locationKey]),
			});
			continue;
		}
		if (existing.seenLocations.has(locationKey)) continue;
		existing.seenLocations.add(locationKey);
		if (exact) existing.exactMatchCount += 1;
		else existing.similarMatchCount += 1;
		existing.score += Number.isFinite(result.score) ? result.score : 0;
		const currentExact = isExactSearchMatch(query, existing.result);
		if (
			(exact && !currentExact) ||
			(exact === currentExact && result.score > existing.result.score)
		) {
			existing.result = { ...result, exactMatchCount: 0, similarMatchCount: 0 };
		}
	}

	return [...aggregates.values()]
		.map(({ result, exactMatchCount, similarMatchCount, score }) => ({
			...result,
			exactMatchCount,
			similarMatchCount,
			score,
		}))
		.sort((left, right) => {
			const exactOrder = Number(right.exactMatchCount > 0) - Number(left.exactMatchCount > 0);
			return exactOrder || right.score - left.score;
		});
}

export class SearchScreenController {
	readonly root: HTMLElement;
	readonly input: HTMLInputElement;

	readonly #options: SearchScreenOptions;
	readonly #submitButton: HTMLButtonElement;
	readonly #courseScopeHost: HTMLElement;
	readonly #folderInput: HTMLInputElement;
	readonly #countLabel: HTMLElement;
	readonly #resultsHost: HTMLElement;
	readonly #noteHost: HTMLElement;
	#requestId = 0;
	#courses: CourseDashboardEntry[] = [];
	#coursesLoaded = false;
	#model: SearchModel = {
		query: "",
		courseIds: [],
		folder: "",
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
		const scope = el("div", "fuzzy-search-scope");
		const courseLabel = el("div", "fuzzy-search-scope-field");
		courseLabel.append(el("span", "", "授業の範囲（複数選択できます）"));
		this.#courseScopeHost = el("div", "fuzzy-search-course-tree");
		this.#courseScopeHost.append(
			el("p", "fuzzy-course-tree-hint", "学期をクリックすると授業を開けます。"),
		);
		courseLabel.append(this.#courseScopeHost);
		const folderLabel = el("label", "fuzzy-search-scope-field");
		folderLabel.append(el("span", "", "フォルダーの範囲"));
		this.#folderInput = el("input");
		this.#folderInput.type = "text";
		this.#folderInput.placeholder = "例: データベース/第4回";
		this.#folderInput.setAttribute("aria-label", "フォルダーの範囲");
		folderLabel.append(this.#folderInput);
		scope.append(courseLabel, folderLabel);

		const meta = el("div", "fuzzy-search-meta");
		this.#countLabel = el("p");
		meta.append(this.#countLabel);
		panel.append(form, scope, meta);

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
			const row = event.target.closest<HTMLElement>(".fuzzy-result-row");
			if (!row?.dataset.resultKey) return;
			this.#model.selectedResultKey = row.dataset.resultKey;
			this.#renderSelection();
		});
		this.#folderInput.addEventListener("input", () => {
			this.#model.folder = this.#folderInput.value;
		});
		void this.#loadCourses();
		this.#render();
	}

	async #loadCourses(): Promise<void> {
		try {
			const api = await this.#options.api;
			if (!api.getDashboard) return;
			const dashboard = await api.getDashboard();
			this.#renderCourseTree(dashboard.courses);
		} catch {
			// 範囲選択は任意なので、コース一覧の取得失敗だけで検索を止めない。
		}
	}

	#renderCourseTree(courses: readonly CourseDashboardEntry[]): void {
		this.#courses = [...courses];
		if (!this.#coursesLoaded) {
			this.#model.courseIds = courses.map((course) => course.courseId);
			this.#coursesLoaded = true;
		}
		const scopeActions = el("div", "fuzzy-course-tree-actions");
		const selectAll = el("button", "fuzzy-course-tree-option", "すべて選択");
		selectAll.dataset.selectAllCourses = "true";
		selectAll.type = "button";
		selectAll.addEventListener("click", () => {
			this.#model.courseIds = this.#courses.map((course) => course.courseId);
			this.#updateCourseTreeSelection();
		});
		const clearAll = el("button", "fuzzy-course-tree-option", "すべて解除");
		clearAll.dataset.clearAllCourses = "true";
		clearAll.type = "button";
		clearAll.addEventListener("click", () => {
			this.#model.courseIds = [];
			this.#updateCourseTreeSelection();
		});
		scopeActions.append(selectAll, clearAll);
		this.#courseScopeHost.replaceChildren(
			el("p", "fuzzy-course-tree-hint", "学期をクリックすると授業を開けます。"),
			scopeActions,
		);
		for (const group of groupCourses(courses)) {
			const details = document.createElement("details");
			details.className = "fuzzy-course-tree-group";
			const summary = document.createElement("summary");
			const groupCheckbox = document.createElement("input");
			groupCheckbox.type = "checkbox";
			groupCheckbox.dataset.courseGroup = group.key;
			groupCheckbox.dataset.courseIds = group.courses.map((course) => course.courseId).join(",");
			groupCheckbox.setAttribute("aria-label", `${group.label}をまとめて選択`);
			groupCheckbox.addEventListener("click", (event) => event.stopPropagation());
			groupCheckbox.addEventListener("change", () => {
				const groupIds = group.courses.map((course) => course.courseId);
				const selected = new Set(this.#model.courseIds);
				for (const courseId of groupIds) {
					if (groupCheckbox.checked) selected.add(courseId);
					else selected.delete(courseId);
				}
				this.#model.courseIds = [...selected];
				this.#updateCourseTreeSelection();
			});
			summary.append(
				groupCheckbox,
				el("span", "", group.label),
				el("small", "", `${group.courses.length}授業`),
			);
			const items = el("div", "fuzzy-course-tree-items");
			for (const course of group.courses) {
				const option = el("label", "fuzzy-course-tree-option");
				const checkbox = document.createElement("input");
				checkbox.type = "checkbox";
				checkbox.dataset.courseId = String(course.courseId);
				const selected = this.#model.courseIds.includes(course.courseId);
				option.classList.toggle("is-selected", selected);
				checkbox.checked = selected;
				checkbox.addEventListener("change", () => {
					const courseId = course.courseId;
					this.#model.courseIds = checkbox.checked
						? [...this.#model.courseIds, courseId]
						: this.#model.courseIds.filter((selectedId) => selectedId !== courseId);
					this.#updateCourseTreeSelection();
				});
				option.append(checkbox, el("span", "", course.courseName));
				items.append(option);
			}
			details.append(summary, items);
			this.#courseScopeHost.append(details);
		}
		this.#updateCourseTreeSelection();
	}

	#folderScope(): string | null {
		const folder = this.#model.folder.trim().replaceAll("\\", "/");
		return folder || null;
	}

	#searchScope(): SearchScope | undefined | null {
		const folder = this.#folderScope();
		if (!this.#coursesLoaded) {
			return folder ? { courseId: null, courseIds: null, folder } : undefined;
		}
		if (this.#model.courseIds.length === 0) return null;
		if (this.#model.courseIds.length === this.#courses.length) {
			return folder ? { courseId: null, courseIds: null, folder } : undefined;
		}
		return {
			courseId: null,
			courseIds: [...this.#model.courseIds],
			folder,
		};
	}

	#updateCourseTreeSelection(): void {
		const selectedIds = new Set(this.#model.courseIds);
		for (const option of this.#courseScopeHost.querySelectorAll<HTMLElement>(
			".fuzzy-course-tree-option",
		)) {
			const checkbox = option.querySelector<HTMLInputElement>("input[data-course-id]");
			if (checkbox) {
				const selected = selectedIds.has(Number(checkbox.dataset.courseId));
				checkbox.checked = selected;
				option.classList.toggle("is-selected", selected);
			}
		}
		for (const group of this.#courseScopeHost.querySelectorAll<HTMLInputElement>(
			"input[data-course-group]",
		)) {
			const ids = (group.dataset.courseIds ?? "")
				.split(",")
				.map(Number)
				.filter(Number.isSafeInteger);
			const count = ids.filter((courseId) => selectedIds.has(courseId)).length;
			group.checked = ids.length > 0 && count === ids.length;
			group.indeterminate = count > 0 && count < ids.length;
		}
	}

	#resultKey(result: SearchResult, index: number): string {
		return `${result.fileId}:${result.page ?? "none"}:${index}`;
	}

	#formatPage(result: SearchResult, compact = false): string {
		if (result.source === "moodle_text") return compact ? "Moodle" : "Moodle本文";
		if (result.page === null) return compact ? "—" : "ページ情報なし";
		if (result.pageCount === null) return compact ? `p.${result.page}` : `${result.page}ページ`;
		return compact
			? `p.${result.page} / ${result.pageCount}`
			: `${result.page} / ${result.pageCount}ページ`;
	}

	#createResultRow(result: SearchPresentationResult, index: number): HTMLDivElement {
		const row = el("div", "fuzzy-result-row");
		row.dataset.resultKey = this.#resultKey(result, index);

		const kindClass = result.source === "moodle_text" ? "" : fileKindClass(result.fileName);
		const kind = el(
			"div",
			kindClass ? `fuzzy-result-kind ${kindClass}` : "fuzzy-result-kind",
			result.source === "moodle_text" ? "本文" : fileKindLabel(result.fileName),
		);
		const main = el("div", "fuzzy-result-main");
		main.append(
			el("p", "fuzzy-result-title", result.fileName),
			el("p", "fuzzy-result-sub", result.courseName ?? "授業名なし"),
		);
		const side = el("div", "fuzzy-result-side");
		const detailButton = el("button", "fuzzy-result-detail", "詳細を見る");
		detailButton.type = "button";
		detailButton.addEventListener("click", (event) => {
			event.stopPropagation();
			const resultKey = row.dataset.resultKey ?? null;
			this.#model.selectedResultKey = resultKey;
			this.#renderSelection();
			const selected = this.#model.results.find(
				(candidate, candidateIndex) => this.#resultKey(candidate, candidateIndex) === resultKey,
			);
			if (selected) void this.#openResult(selected);
		});
		side.append(
			el(
				"p",
				"fuzzy-result-match-count",
				`完全一致 ${result.exactMatchCount}件 / 近い一致 ${result.similarMatchCount}件`,
			),
			el("p", "", this.#formatPage(result, true)),
			detailButton,
		);
		row.append(kind, main, el("p", "fuzzy-result-snippet", result.snippet), side);
		return row;
	}

	async #openResult(result: SearchResult): Promise<void> {
		if (result.source === "moodle_text" && result.moodleUrl) {
			window.open(result.moodleUrl, "_blank", "noopener,noreferrer");
			this.#noteHost.append(
				el("p", "fuzzy-note-copy fuzzy-note-success", "Moodle上の該当位置を開きました。"),
			);
			return;
		}
		try {
			const api = await this.#options.api;
			const opened = await api.openFile({
				fileId: result.fileId,
				page: result.page,
			});
			if (!opened.opened) throw new Error("資料を開けませんでした");
			this.#noteHost.append(
				el(
					"p",
					"fuzzy-note-copy fuzzy-note-success",
					result.page === null
						? "資料を既定のアプリケーションで開きました。"
						: `${this.#formatPage(result)}付近の資料を既定のアプリケーションで開きました。`,
				),
			);
			this.#options.onApiReady(api);
		} catch (error) {
			console.warn("[fuzzy] 検索結果を開けませんでした", error);
			this.#noteHost.append(
				el(
					"p",
					"fuzzy-note-copy fuzzy-note-error",
					"資料を開けませんでした。保存先に資料があるか確認してください。",
				),
			);
		}
	}

	#renderSelection(): void {
		const selected =
			this.#model.results.find(
				(result, index) => this.#resultKey(result, index) === this.#model.selectedResultKey,
			) ?? null;
		for (const row of this.#resultsHost.querySelectorAll<HTMLElement>(".fuzzy-result-row")) {
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
			["所在", selected.source === "moodle_text" ? "Moodle本文" : selected.relativePath],
			["ページ", this.#formatPage(selected)],
			["完全一致", `${selected.exactMatchCount}件`],
			["近い一致", `${selected.similarMatchCount}件`],
		]) {
			const row = el("div");
			row.append(el("dt", "", term), el("dd", "", detail));
			grid.append(row);
		}
		this.#noteHost.replaceChildren(
			el(
				"p",
				"fuzzy-section-label",
				selected.source === "moodle_text" ? "選択中のMoodle本文" : "選択中の資料",
			),
			el("h2", "", selected.fileName),
			el(
				"p",
				"fuzzy-note-copy",
				selected.source === "moodle_text"
					? "Moodle本文の該当ブロックを見つけました。「詳細を見る」で元の位置を開けます。"
					: selected.page === null
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
			? `「${executedQuery}」に一致: ${results.length}件`
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
			const scope = this.#searchScope();
			if (scope === null) {
				this.#model.presentation = {
					tone: "warning",
					title: "検索する授業を1つ以上選択してください。",
				};
				this.#render();
				return;
			}
			const queryVariants = buildSearchQueryVariants(query);
			const resultSets = await boundedParallelMap(queryVariants, 2, (queryVariant) =>
				api.search(queryVariant, scope),
			);
			const results = aggregateSearchResults(resultSets.flat(), query);
			if (requestId !== this.#requestId) return;
			this.#model = {
				query: this.#model.query,
				courseIds: this.#model.courseIds,
				folder: this.#model.folder,
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
