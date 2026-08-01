import type {
	Assignment,
	AssignmentChange,
	DataSyncEvent,
	FuzzyApiClient,
	PresentationState,
} from "@fuzzy/shared";
import { syncEventChangeCursor } from "../../lib/notifications/syncNotificationNavigation";
import { DEADLINE_REVIEW_HELP_TEXT } from "../../lib/ui/screenCopy";
import { createCalendarPanelController } from "./calendarPanel";
import { buildShellScreenHeader, shellElement as el } from "./shellElements";
import {
	type DeadlineViewFilter,
	assignmentChangeFieldLabel,
	assignmentChangeValueLabel,
	deadlineFilterLabel,
	formatDate,
	formatSyncDate,
	isNeedsReview,
	isOverdue,
	isUpcoming,
	parseDueAt,
	sourceLabel,
	submissionAvailabilityLabel,
	submissionLabel,
	syncChangeTotal,
	syncTriggerLabel,
} from "./shellPresentation";

interface DeadlineScreenOptions {
	api: Promise<
		Pick<
			FuzzyApiClient,
			| "getDeadlines"
			| "getLatestSyncEvent"
			| "getAssignmentChanges"
			| "updateSubmissionStatus"
			| "getNotificationRules"
			| "updateNotificationRules"
		> & {
			readonly mode: FuzzyApiClient["mode"] | "unknown";
		}
	>;
	onApiReady: (api: { readonly mode: FuzzyApiClient["mode"] | "unknown" }) => void;
	onChange: () => void;
}

export class DeadlineScreenController {
	readonly #options: DeadlineScreenOptions;
	readonly #calendarPanel;
	#filter: DeadlineViewFilter = "all";
	#assignments: Assignment[] = [];
	#assignmentState: PresentationState = {
		tone: "loading",
		title: "課題・締切を読み込んでいます…",
	};
	#assignmentLoad: Promise<void> | null = null;
	#submissionError: PresentationState | null = null;
	#latestSyncEvent: DataSyncEvent | null = null;
	#assignmentChanges: AssignmentChange[] = [];
	#assignmentChangeCursor: number | undefined;
	#syncState: PresentationState = {
		tone: "loading",
		title: "Moodleの更新情報を確認しています…",
	};
	#syncLoad: Promise<void> | null = null;

	constructor(options: DeadlineScreenOptions) {
		this.#options = options;
		this.#calendarPanel = createCalendarPanelController({
			onChange: options.onChange,
		});
	}

	openSyncEvent(syncEventId: number): void {
		this.#assignmentChangeCursor = syncEventChangeCursor(syncEventId);
		this.#syncState = {
			tone: "loading",
			title: "通知時点以降の変更を確認しています…",
		};
		this.#options.onChange();
	}

	render(): HTMLElement {
		this.#ensureLoaded();
		const screen = el("div", "fuzzy-screen");
		screen.append(buildShellScreenHeader("deadlines"));

		if (this.#assignmentState.tone === "error") {
			screen.append(
				this.#buildRetryPanel(
					this.#assignmentState,
					() => {
						this.#assignmentState = {
							tone: "loading",
							title: "課題・締切を読み込んでいます…",
						};
						this.#options.onChange();
					},
					"再読み込み",
				),
			);
			return screen;
		}
		if (this.#assignmentState.tone === "loading") {
			screen.append(el("section", "fuzzy-placeholder", this.#assignmentState.title));
			return screen;
		}
		if (this.#submissionError) {
			const errorPanel = el("section", "fuzzy-error-panel");
			const errorHead = el("div", "fuzzy-error-panel-head");
			const closeButton = el("button", "fuzzy-error-close", "閉じる");
			closeButton.type = "button";
			closeButton.addEventListener("click", () => {
				this.#submissionError = null;
				this.#options.onChange();
			});
			errorHead.append(el("p", "", this.#submissionError.title), closeButton);
			errorPanel.append(errorHead);
			screen.append(errorPanel);
		}

		screen.append(
			this.#buildMetrics(),
			this.#buildSyncSummary(),
			this.#calendarPanel.render(this.#assignments),
			this.#buildToolbar(),
			this.#buildList(),
		);
		return screen;
	}

	#ensureLoaded(): void {
		if (this.#assignmentState.tone === "loading" && !this.#assignmentLoad) {
			this.#assignmentLoad = this.#loadAssignments().finally(() => {
				this.#assignmentLoad = null;
				this.#options.onChange();
			});
		}
		if (this.#syncState.tone === "loading" && !this.#syncLoad) {
			this.#syncLoad = this.#loadSyncSummary().finally(() => {
				this.#syncLoad = null;
				this.#options.onChange();
			});
		}
		this.#calendarPanel.ensureNotificationRulesLoaded();
	}

	async #loadAssignments(): Promise<void> {
		try {
			const api = await this.#options.api;
			this.#assignments = await api.getDeadlines({ includePast: true });
			this.#assignmentState = {
				tone: this.#assignments.length > 0 ? "ready" : "empty",
				title:
					this.#assignments.length > 0
						? "課題・締切を表示しています"
						: "表示できる課題がありません",
			};
			this.#options.onApiReady(api);
		} catch (error) {
			console.warn("[fuzzy] 課題・締切の取得に失敗しました", error);
			this.#assignmentState = {
				tone: "error",
				title: "課題・締切を読み込めませんでした。",
				impact: "時間をおいて再度お試しください。",
				technicalDetails: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async #loadSyncSummary(): Promise<void> {
		try {
			const api = await this.#options.api;
			this.#latestSyncEvent = await api.getLatestSyncEvent();
			this.#assignmentChanges = this.#latestSyncEvent
				? await api.getAssignmentChanges(this.#assignmentChangeCursor)
				: [];
			this.#syncState = {
				tone: this.#latestSyncEvent ? "ready" : "empty",
				title: this.#latestSyncEvent
					? "Moodleの更新情報を表示しています"
					: "まだMoodleから取得した記録がありません",
			};
			this.#options.onApiReady(api);
		} catch (error) {
			console.warn("[fuzzy] Moodleの更新情報を確認できませんでした", error);
			this.#syncState = {
				tone: "error",
				title: "Moodleの更新情報を確認できませんでした。",
				impact: "締切一覧は表示できます。変更点だけ後でもう一度確認してください。",
				technicalDetails: error instanceof Error ? error.message : String(error),
			};
		}
	}

	#visibleAssignments(): Assignment[] {
		const filtered = this.#assignments.filter((assignment) => {
			switch (this.#filter) {
				case "upcoming":
					return isUpcoming(assignment);
				case "overdue":
					return isOverdue(assignment);
				case "review":
					return isNeedsReview(assignment);
				default:
					return true;
			}
		});
		return filtered.sort((left, right) => {
			if (left.submitted !== right.submitted) return left.submitted ? 1 : -1;
			if (isNeedsReview(left) !== isNeedsReview(right)) return isNeedsReview(left) ? -1 : 1;
			return (
				(parseDueAt(left.dueAt) ?? Number.MAX_SAFE_INTEGER) -
				(parseDueAt(right.dueAt) ?? Number.MAX_SAFE_INTEGER)
			);
		});
	}

	#buildDeadlineCard(assignment: Assignment): HTMLElement {
		const card = el("article", "fuzzy-deadline-card");
		card.classList.toggle("is-submitted", assignment.submitted);
		card.classList.toggle("is-review", isNeedsReview(assignment));
		card.classList.toggle("is-overdue", isOverdue(assignment));

		const heading = el("div");
		heading.append(
			el("p", "fuzzy-course-name", assignment.courseName),
			el("h2", "", assignment.title),
		);
		const badges = el("div", "fuzzy-deadline-badges");
		badges.append(el("span", "fuzzy-badge", submissionLabel(assignment)));
		if (isNeedsReview(assignment)) {
			badges.append(el("span", "fuzzy-badge is-review", "締切日を確認"));
		}
		if (isOverdue(assignment)) badges.append(el("span", "fuzzy-badge is-overdue", "期限切れ"));
		const availability = submissionAvailabilityLabel(assignment);
		if (availability) {
			badges.append(
				el(
					"span",
					availability === "提出可能" ? "fuzzy-badge is-available" : "fuzzy-badge is-review",
					availability,
				),
			);
		}
		badges.append(
			el(
				"span",
				assignment.submitted ? "fuzzy-badge is-submitted" : "fuzzy-badge is-open",
				assignment.submitted ? "提出済み" : "未提出",
			),
		);
		const head = el("div", "fuzzy-deadline-head");
		head.append(heading, badges);

		const due = el("div");
		due.append(
			el("p", "fuzzy-deadline-label", "期限"),
			el("p", "fuzzy-deadline-value", formatDate(assignment.dueAt)),
		);
		const body = el("div", "fuzzy-deadline-body");
		body.append(due, el("p", "fuzzy-deadline-source", sourceLabel(assignment)));

		const checkbox = el("input");
		checkbox.type = "checkbox";
		checkbox.checked = assignment.submitted;
		checkbox.addEventListener("change", () => {
			void this.#updateSubmission(assignment, checkbox.checked);
			checkbox.disabled = true;
		});
		const checkLabel = el("label", "fuzzy-checkline");
		checkLabel.append(
			checkbox,
			el("span", "", assignment.submitted ? "未提出に戻す" : "提出済みにする"),
		);
		const actions = el("div", "fuzzy-deadline-actions");
		actions.append(checkLabel);
		if (assignment.moodleUrl) {
			const openMoodle = el("a", "fuzzy-secondary-link", "Moodleで課題を確認");
			openMoodle.href = assignment.moodleUrl;
			openMoodle.target = "_blank";
			openMoodle.rel = "noopener noreferrer";
			actions.append(openMoodle);
		}
		card.append(head, body, actions);
		return card;
	}

	async #updateSubmission(assignment: Assignment, submitted: boolean): Promise<void> {
		try {
			const api = await this.#options.api;
			const result = await api.updateSubmissionStatus(assignment.id, submitted);
			if (!result.ok) throw new Error("サーバーが更新を受け付けませんでした。");
			this.#submissionError = null;
			this.#assignments = this.#assignments.map((item) =>
				item.id === assignment.id ? { ...item, submitted } : item,
			);
		} catch (error) {
			console.warn("[fuzzy] 提出状態の更新に失敗しました", error);
			this.#submissionError = {
				tone: "error",
				title: "提出状態を更新できませんでした。時間をおいて再度お試しください。",
				technicalDetails: error instanceof Error ? error.message : String(error),
			};
		}
		this.#options.onChange();
	}

	#buildSyncSummary(): HTMLElement {
		const panel = el("section", "fuzzy-sync-panel");
		const title = el("div");
		title.append(
			el("p", "fuzzy-section-label", "Moodleの更新情報"),
			el("h2", "", "新しく取得した内容"),
		);
		const reload = el("button", "fuzzy-sync-action", "最新情報を読み込む");
		reload.type = "button";
		reload.disabled = this.#syncState.tone === "loading";
		reload.addEventListener("click", () => {
			this.#syncState = { tone: "loading", title: "Moodleの更新情報を確認しています…" };
			this.#options.onChange();
		});
		const head = el("div", "fuzzy-sync-head");
		head.append(title, reload);
		panel.append(head);

		if (this.#syncState.tone === "loading") {
			panel.append(el("p", "fuzzy-toolbar-copy", this.#syncState.title));
			return panel;
		}
		if (this.#syncState.tone === "error") {
			const error = el("div", "fuzzy-sync-error");
			error.append(
				el("p", "", this.#syncState.title),
				el("p", "", this.#syncState.impact ?? "変更点だけ後でもう一度確認してください。"),
			);
			panel.append(error);
			return panel;
		}
		if (!this.#latestSyncEvent) {
			panel.append(el("p", "fuzzy-toolbar-copy", this.#syncState.title));
			return panel;
		}

		const event = this.#latestSyncEvent;
		const total = syncChangeTotal(event);
		const summary = el("div", "fuzzy-sync-summary");
		summary.append(
			el(
				"p",
				"fuzzy-sync-message",
				total > 0 ? `Moodleからデータを取得しました（対象${total}件）` : "最新です",
			),
			el(
				"p",
				"fuzzy-sync-meta",
				`${formatSyncDate(event.syncedAt)}・${syncTriggerLabel(event.trigger)}`,
			),
		);
		const counts = el("div", "fuzzy-sync-counts");
		for (const [label, value] of [
			["新規", event.newAssignmentCount],
			["変更", event.changedAssignmentCount],
			["削除", event.removedAssignmentCount],
		] as const) {
			const count = el("div", "fuzzy-sync-count");
			count.append(el("span", "", label), el("strong", "", String(value)));
			counts.append(count);
		}
		panel.append(summary, counts, this.#buildChangeList());
		return panel;
	}

	#buildChangeList(): HTMLElement {
		const list = el("div", "fuzzy-change-list");
		const label =
			this.#assignmentChangeCursor === undefined ? "変更内容" : "通知時点以降の変更内容";
		list.append(
			el("p", "fuzzy-change-list-label", `${label}（${this.#assignmentChanges.length}件）`),
		);
		if (this.#assignmentChanges.length === 0) {
			list.append(el("p", "fuzzy-toolbar-copy", "表示する変更点はありません。"));
			return list;
		}
		for (const change of this.#assignmentChanges) {
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
			const row = el("article", "fuzzy-change-row");
			row.append(main, diff);
			list.append(row);
		}
		return list;
	}

	#buildMetrics(): HTMLElement {
		const grid = el("section", "fuzzy-metric-grid");
		for (const metric of [
			{ label: "未提出", value: this.#assignments.filter((item) => !item.submitted).length },
			{
				label: "締切日を確認",
				value: this.#assignments.filter(isNeedsReview).length,
				className: "is-warn",
			},
			{
				label: "期限切れ",
				value: this.#assignments.filter(isOverdue).length,
				className: "is-soft",
			},
		]) {
			const card = el(
				"article",
				metric.className ? `fuzzy-metric-card ${metric.className}` : "fuzzy-metric-card",
			);
			card.append(
				el("p", "fuzzy-metric-label", metric.label),
				el("p", "fuzzy-metric-value", String(metric.value)),
			);
			grid.append(card);
		}
		return grid;
	}

	#buildToolbar(): HTMLElement {
		const filterRow = el("div", "fuzzy-filter-row");
		for (const filter of ["all", "upcoming", "overdue", "review"] as const) {
			const button = el(
				"button",
				this.#filter === filter ? "fuzzy-filter-chip is-active" : "fuzzy-filter-chip",
				deadlineFilterLabel(filter),
			);
			button.type = "button";
			button.setAttribute("aria-pressed", String(this.#filter === filter));
			button.addEventListener("click", () => {
				this.#filter = filter;
				this.#options.onChange();
			});
			filterRow.append(button);
		}
		const toolbar = el("section", "fuzzy-deadline-toolbar");
		toolbar.append(filterRow, el("p", "fuzzy-toolbar-copy", DEADLINE_REVIEW_HELP_TEXT));
		return toolbar;
	}

	#buildList(): HTMLElement {
		const host = el("section", "fuzzy-deadline-list");
		const visible = this.#visibleAssignments();
		if (visible.length > 0) {
			host.append(...visible.map((assignment) => this.#buildDeadlineCard(assignment)));
			return host;
		}
		const empty = el("section", "fuzzy-empty");
		empty.append(
			el("h2", "", "表示できる課題がありません"),
			el("p", "", "この条件に合う締切は今のところ見つかっていません。"),
		);
		host.append(empty);
		return host;
	}

	#buildRetryPanel(state: PresentationState, retry: () => void, label: string): HTMLElement {
		const panel = el("section", "fuzzy-error-panel");
		const button = el("button", "fuzzy-primary-button", label);
		button.type = "button";
		button.addEventListener("click", retry);
		panel.append(el("p", "", state.title));
		if (state.impact) panel.append(el("p", "", state.impact));
		panel.append(button);
		return panel;
	}
}
