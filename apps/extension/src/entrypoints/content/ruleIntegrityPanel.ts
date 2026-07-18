import type { DuplicateGroupListItem, RuleViolationListItem } from "@fuzzy/shared";
import { duplicateMethodLabel, summarizeRuleIntegrity } from "../../lib/integrity/ruleIntegrity";
import type {
	RuleIntegrityController,
	RuleIntegrityState,
	RuleIntegrityTarget,
} from "../../lib/integrity/state";
import { ensureRuleIntegrityPanelStyle } from "./ruleIntegrityPanelStyle";
import { element } from "./rulesScreenElements";

const VIOLATION_ERROR_MESSAGE =
	"ルール違反ファイルを取得できませんでした。時間をおいて再試行してください。";
const DUPLICATE_ERROR_MESSAGE = "重複候補を取得できませんでした。時間をおいて再試行してください。";

export interface RuleIntegrityPanel {
	root: HTMLElement;
	activate(): Promise<void>;
	deactivate(): void;
	refresh(target?: RuleIntegrityTarget): Promise<void>;
	invalidate(target?: RuleIntegrityTarget): void;
}

export function createRuleIntegrityPanel(controller: RuleIntegrityController): RuleIntegrityPanel {
	ensureRuleIntegrityPanelStyle();
	const root = element("section", "fuzzy-integrity-panel");
	root.id = "fuzzy-rule-integrity-panel";
	root.setAttribute("role", "tabpanel");
	root.setAttribute("aria-labelledby", "fuzzy-rule-integrity-tab");

	const refresh = (target: RuleIntegrityTarget = "all") => controller.refresh(target);

	const render = (state: Readonly<RuleIntegrityState>) => {
		const isLoading =
			state.violations.status === "loading" || state.duplicates.status === "loading";
		const header = element("header", "fuzzy-integrity-header");
		const heading = element("div");
		heading.append(
			element("h2", "", "警告・未整理ファイル"),
			element(
				"p",
				"fuzzy-integrity-copy",
				"保存ルールから外れた資料と重複候補を確認できます。自動移動・自動削除は行いません。",
			),
		);
		const refreshButton = element(
			"button",
			"fuzzy-integrity-button is-primary",
			isLoading ? "更新中…" : "最新の状態に更新",
		);
		refreshButton.type = "button";
		refreshButton.disabled = isLoading;
		refreshButton.addEventListener("click", () => void refresh());
		header.append(heading, refreshButton);

		const status = element(
			"p",
			"fuzzy-integrity-update-status",
			isLoading ? "一覧を更新しています…" : readyStatusMessage(state),
		);
		status.setAttribute("role", "status");
		status.setAttribute("aria-live", "polite");

		root.replaceChildren(
			header,
			status,
			buildSummary(state),
			buildViolationSection(state, () => void refresh("violations")),
			buildDuplicateSection(state, () => void refresh("duplicates")),
		);
	};

	controller.subscribe(render);

	return {
		root,
		activate: () => controller.activate(),
		deactivate: () => controller.deactivate(),
		refresh,
		invalidate: (target = "all") => controller.invalidate(target),
	};
}

function buildSummary(state: Readonly<RuleIntegrityState>): HTMLElement {
	const summary = summarizeRuleIntegrity(state.violations.data, state.duplicates.data);
	const wrap = element("section", "fuzzy-integrity-summary");
	wrap.setAttribute("aria-label", "整合性チェックの集計");
	wrap.append(
		buildMetric(
			"ルール違反",
			metricValue(state.violations.status, summary.violationCount, state.violations.data.length),
		),
		buildMetric(
			"影響する授業",
			metricValue(
				state.violations.status,
				summary.affectedCourseCount,
				state.violations.data.length,
			),
		),
		buildMetric(
			"重複グループ",
			metricValue(
				state.duplicates.status,
				summary.duplicateGroupCount,
				state.duplicates.data.length,
			),
		),
		buildMetric(
			"重複候補ファイル",
			metricValue(
				state.duplicates.status,
				summary.duplicateFileCount,
				state.duplicates.data.length,
			),
		),
	);
	return wrap;
}

function buildMetric(label: string, value: string): HTMLElement {
	const card = element("article", "fuzzy-integrity-metric");
	card.append(
		element("p", "fuzzy-integrity-metric-label", label),
		element("p", "fuzzy-integrity-metric-value", value),
	);
	return card;
}

function metricValue(status: string, count: number, cachedCount: number): string {
	if ((status === "idle" || status === "loading") && cachedCount === 0) return "—";
	if (status === "error" && cachedCount === 0) return "—";
	return `${count}件`;
}

function buildViolationSection(
	state: Readonly<RuleIntegrityState>,
	onRetry: () => void,
): HTMLElement {
	const section = buildSection("ルール違反ファイル", "fuzzy-integrity-violations-title");
	section.setAttribute("aria-busy", String(state.violations.status === "loading"));
	const body = element("div", "fuzzy-integrity-section-body");
	appendResourceState(
		body,
		state.violations.status,
		state.violations.data.length,
		VIOLATION_ERROR_MESSAGE,
		onRetry,
		"ルール違反は見つかりませんでした。",
	);
	if (state.violations.data.length > 0) {
		const list = element("ul", "fuzzy-integrity-list");
		for (const violation of state.violations.data) list.append(buildViolationItem(violation));
		body.append(list);
	}
	section.append(body);
	return section;
}

function buildViolationItem(violation: RuleViolationListItem): HTMLLIElement {
	const item = element("li", "fuzzy-integrity-list-item");
	const card = element("article", "fuzzy-integrity-card");
	const head = element("div", "fuzzy-integrity-card-head");
	const title = element("div");
	title.append(
		element("h4", "", violation.fileName),
		element("p", "fuzzy-integrity-course", violation.courseName ?? "授業未設定"),
	);
	head.append(title, element("span", "fuzzy-integrity-badge is-warning", "要確認"));
	card.append(
		head,
		buildPath(violation.relativePath),
		element("p", "fuzzy-integrity-reason", violation.reason),
	);
	item.append(card);
	return item;
}

function buildDuplicateSection(
	state: Readonly<RuleIntegrityState>,
	onRetry: () => void,
): HTMLElement {
	const section = buildSection("重複・類似ファイル", "fuzzy-integrity-duplicates-title");
	section.setAttribute("aria-busy", String(state.duplicates.status === "loading"));
	const body = element("div", "fuzzy-integrity-section-body");
	appendResourceState(
		body,
		state.duplicates.status,
		state.duplicates.data.length,
		DUPLICATE_ERROR_MESSAGE,
		onRetry,
		"重複・類似ファイルは見つかりませんでした。",
	);
	if (state.duplicates.data.length > 0) {
		const list = element("ul", "fuzzy-integrity-list");
		for (const group of state.duplicates.data) list.append(buildDuplicateGroup(group));
		body.append(list);
	}
	section.append(body);
	return section;
}

function buildDuplicateGroup(group: DuplicateGroupListItem): HTMLLIElement {
	const item = element("li", "fuzzy-integrity-list-item");
	const card = element("article", "fuzzy-integrity-card");
	const head = element("div", "fuzzy-integrity-card-head");
	const heading = element("h4", "", `重複グループ ${group.groupId}`);
	head.append(
		heading,
		element("span", "fuzzy-integrity-badge", duplicateMethodLabel(group.method)),
	);
	const members = element("ul", "fuzzy-integrity-member-list");
	for (const member of group.members) {
		const memberItem = element("li", "fuzzy-integrity-member");
		const nameRow = element("div", "fuzzy-integrity-member-head");
		nameRow.append(
			element("strong", "", member.fileName),
			element("span", "", `一致度 ${formatSimilarity(member.similarity)}`),
		);
		memberItem.append(nameRow, buildPath(member.relativePath));
		members.append(memberItem);
	}
	card.append(head, members);
	item.append(card);
	return item;
}

function buildSection(title: string, titleId: string): HTMLElement {
	const section = element("section", "fuzzy-integrity-section");
	section.setAttribute("aria-labelledby", titleId);
	const heading = element("h3", "", title);
	heading.id = titleId;
	section.append(heading);
	return section;
}

function buildPath(relativePath: string): HTMLElement {
	const row = element("p", "fuzzy-integrity-path");
	row.append(element("span", "", "保存ルート › "), element("code", "", relativePath));
	return row;
}

function appendResourceState(
	body: HTMLElement,
	status: string,
	itemCount: number,
	errorMessage: string,
	onRetry: () => void,
	emptyMessage: string,
): void {
	if (status === "loading") {
		const loading = element(
			"p",
			"fuzzy-integrity-resource-status",
			itemCount > 0 ? "表示中の結果を更新しています…" : "一覧を読み込んでいます…",
		);
		loading.setAttribute("role", "status");
		body.append(loading);
	}
	if (status === "error") {
		const alert = element("div", "fuzzy-integrity-alert");
		alert.setAttribute("role", "alert");
		const retry = element("button", "fuzzy-integrity-button", "この一覧を再試行");
		retry.type = "button";
		retry.addEventListener("click", onRetry);
		alert.append(element("p", "", errorMessage), retry);
		body.append(alert);
	}
	if (status === "ready" && itemCount === 0) {
		body.append(element("p", "fuzzy-integrity-empty", emptyMessage));
	}
}

function formatSimilarity(similarity: number): string {
	return `${Math.round(similarity * 100)}%`;
}

function readyStatusMessage(state: Readonly<RuleIntegrityState>): string {
	if (state.violations.status === "idle" && state.duplicates.status === "idle") return "";
	if (state.violations.status === "ready" && state.duplicates.status === "ready") {
		return "一覧を最新の状態に更新しました。";
	}
	return "取得できた一覧を表示しています。";
}
