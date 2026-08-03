import type { DashboardSummary, PresentationState } from "@fuzzy/shared";
import { groupCourses } from "./courseHierarchy";
import { buildShellScreenHeader, shellElement as el } from "./shellElements";
import { formatCacheDate, formatDate } from "./shellPresentation";

export interface DashboardScreenModel {
	dashboard: DashboardSummary | null;
	presentation: PresentationState;
	cachedAt: string | null;
	usesCache: boolean;
}

interface DashboardScreenActions {
	reload: () => void;
	openDeadlines: () => void;
}

export function buildDashboardScreen(
	model: Readonly<DashboardScreenModel>,
	actions: DashboardScreenActions,
): HTMLElement {
	const screen = el("div", "fuzzy-screen");
	screen.append(buildShellScreenHeader("dashboard"));

	if (model.presentation.tone === "error") {
		const errorPanel = el("section", "fuzzy-error-panel");
		const retryButton = el("button", "fuzzy-primary-button", "再読み込み");
		retryButton.type = "button";
		retryButton.addEventListener("click", actions.reload);
		errorPanel.append(el("p", "", model.presentation.title));
		if (model.presentation.impact) {
			errorPanel.append(el("p", "", model.presentation.impact));
		}
		errorPanel.append(retryButton);
		screen.append(errorPanel);
		return screen;
	}

	if (model.presentation.tone === "loading") {
		screen.append(el("section", "fuzzy-placeholder", model.presentation.title));
		return screen;
	}

	if (!model.dashboard) {
		const empty = el("section", "fuzzy-empty");
		empty.append(
			el("h2", "", model.presentation.title),
			el("p", "", model.presentation.impact ?? "Moodleを開いて情報を取得してください。"),
		);
		screen.append(empty);
		return screen;
	}

	const { dashboard } = model;
	const actionsHost = el("div", "fuzzy-dashboard-actions");
	const reloadButton = el("button", "fuzzy-primary-button", "最新情報を読み込む");
	reloadButton.type = "button";
	reloadButton.addEventListener("click", actions.reload);
	actionsHost.append(reloadButton);
	actionsHost.append(
		el(
			"p",
			"fuzzy-dashboard-cache-note",
			model.usesCache
				? `前回保存した情報を表示中（最終更新: ${formatCacheDate(model.cachedAt ?? "")}）`
				: "最新です",
		),
	);
	if (dashboard.upcomingDeadlineCount > 0) {
		const deadlineLink = el("button", "fuzzy-dashboard-deadline-link", "課題・締切を見る");
		deadlineLink.type = "button";
		deadlineLink.addEventListener("click", actions.openDeadlines);
		actionsHost.append(deadlineLink);
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

	const courseList = el("section", "fuzzy-dashboard-course-groups");
	if (dashboard.courses.length === 0) {
		courseList.append(el("p", "fuzzy-toolbar-copy", "表示できるコースはありません。"));
	} else {
		for (const group of groupCourses(dashboard.courses)) {
			const groupDetails = document.createElement("details");
			groupDetails.className = "fuzzy-dashboard-course-group";
			groupDetails.open = true;
			const summary = document.createElement("summary");
			summary.append(
				el("strong", "", group.label),
				el("span", "fuzzy-dashboard-group-count", `${group.courses.length}授業`),
			);
			const cards = el("div", "fuzzy-dashboard-course-list");
			for (const course of group.courses) {
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
				for (const [label, value] of [
					[
						"整理状況",
						course.violationCount > 0 ? `要整理 ${course.violationCount}件` : "整理済み",
					],
					["次の締切", formatDate(course.nextDueAt)],
				]) {
					const row = el("div");
					row.append(el("dt", "", label), el("dd", "", value));
					details.append(row);
				}
				card.append(head, details);
				cards.append(card);
			}
			groupDetails.append(summary, cards);
			courseList.append(groupDetails);
		}
	}

	screen.append(actionsHost, metrics, courseList);
	return screen;
}
