import "@fuzzy/shared/theme.css";
import { readDashboardCache } from "../../lib/cache/dashboardCache";
import { POPUP_NAVIGATION_GUIDE } from "../../lib/ui/screenCopy";
import "./app.css";
import { createPopupDashboardView } from "./popupView";

const target = document.getElementById("app");
if (!target) {
	throw new Error("ポップアップの描画先 #app が見つかりません");
}

target.replaceChildren(buildLoadingView());
void readDashboardCache().then((cached) => {
	target.replaceChildren(buildPopup(createPopupDashboardView(cached)));
});

function buildLoadingView(): HTMLElement {
	const main = element("main", "fuzzy-popup");
	main.append(
		element("p", "fuzzy-popup-kicker", "Fuzzy"),
		element("h1", "", "保存済みの表示情報を確認中"),
		element("p", "fuzzy-popup-body", "オフラインキャッシュを読み込んでいます…"),
	);
	return main;
}

function buildPopup(view: ReturnType<typeof createPopupDashboardView>): HTMLElement {
	const main = element("main", "fuzzy-popup");
	main.append(element("p", "fuzzy-popup-kicker", "Fuzzy"));

	if (view.state === "missing") {
		main.append(
			element("h1", "", "キャッシュがありません"),
			element("p", "fuzzy-popup-body", view.message),
		);
	} else {
		main.append(
			element("h1", "", "前回のダッシュボード"),
			element("p", "fuzzy-popup-cache-date", `最終更新: ${view.updatedAt}`),
		);
		const metrics = element("section", "fuzzy-popup-metrics");
		for (const [label, value] of [
			["保存済み資料", view.totalFiles],
			["整理が必要", view.totalViolations],
			["今後の締切", view.upcomingDeadlineCount],
		] as const) {
			const metric = element("div", "fuzzy-popup-metric");
			metric.append(element("span", "", label), element("strong", "", String(value)));
			metrics.append(metric);
		}
		main.append(metrics);

		const courses = element("section", "fuzzy-popup-courses");
		courses.append(element("h2", "", "コース"));
		if (view.courses.length === 0) {
			courses.append(element("p", "fuzzy-popup-cache-date", "表示できるコースはありません。"));
		} else {
			for (const course of view.courses) {
				const row = element("div", "fuzzy-popup-course");
				row.append(
					element("strong", "", course.name),
					element("span", "", `${course.fileCount}資料・要整理 ${course.violationCount}件`),
				);
				courses.append(row);
			}
		}
		main.append(courses);
	}

	const guide = element("section", "fuzzy-popup-guide");
	guide.append(
		element("h2", "", "最新情報と保存操作"),
		element(
			"p",
			"fuzzy-popup-cache-date",
			"最新情報の取得と資料の保存は、Moodleページ内のFuzzyから行います。",
		),
	);
	const steps = element("ol", "fuzzy-popup-steps");
	for (const text of [
		"Moodleを開く",
		"資料の保存は、授業ページ右側の保存パネルから行う",
		POPUP_NAVIGATION_GUIDE,
	]) {
		steps.append(element("li", "", text));
	}
	guide.append(steps);
	main.append(guide);
	return main;
}

function element<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className = "",
	textContent = "",
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (textContent) node.textContent = textContent;
	return node;
}
