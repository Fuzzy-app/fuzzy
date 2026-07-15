import type { Assignment, FuzzyApiClient, NotificationRule } from "@fuzzy/shared";
import { BackgroundApiClient } from "../../lib/api/backgroundApi";
import {
	buildDeadlineIcs,
	deadlineIcsFileName,
	exportableAssignments,
} from "../../lib/calendar/ics";
import { ensureCalendarPanelStyle } from "./calendarPanelStyle";

type NotificationApi = Pick<
	BackgroundApiClient,
	"getNotificationRules" | "updateNotificationRules"
> & {
	readonly mode: FuzzyApiClient["mode"] | "unknown";
};

export interface CalendarPanelController {
	ensureNotificationRulesLoaded(): void;
	render(assignments: Assignment[]): HTMLElement;
}

interface CalendarPanelOptions {
	onChange: () => void;
	api?: NotificationApi;
	now?: () => number;
	download?: (content: string, fileName: string) => void;
}

type LoadState = "idle" | "loading" | "loaded" | "error";
type ErrorKind = "load" | "save";

export function createCalendarPanelController(
	options: CalendarPanelOptions,
): CalendarPanelController {
	ensureCalendarPanelStyle();
	const api = options.api ?? new BackgroundApiClient();
	const now = options.now ?? Date.now;
	const download = options.download ?? downloadIcsFile;
	let rules: NotificationRule[] = [];
	let loadState: LoadState = "idle";
	let saving = false;
	let errorMessage: string | null = null;
	let errorKind: ErrorKind = "load";
	let exportMessage: string | null = null;

	const ensureNotificationRulesLoaded = (): void => {
		if (loadState !== "idle") return;
		loadState = "loading";
		void api
			.getNotificationRules()
			.then((loadedRules) => {
				rules = loadedRules;
				loadState = "loaded";
				errorMessage = null;
			})
			.catch((error) => {
				loadState = "error";
				errorKind = "load";
				errorMessage = error instanceof Error ? error.message : String(error);
			})
			.finally(options.onChange);
	};

	const retryLoad = (): void => {
		loadState = "idle";
		errorMessage = null;
		ensureNotificationRulesLoaded();
		options.onChange();
	};

	const updateRule = async (ruleId: number, enabled: boolean): Promise<void> => {
		if (saving) return;
		const previousRules = rules;
		rules = rules.map((rule) => (rule.id === ruleId ? { ...rule, enabled } : rule));
		saving = true;
		errorMessage = null;
		options.onChange();

		try {
			const result = await api.updateNotificationRules(rules);
			if (!result.ok) throw new Error("通知設定を保存できませんでした");
		} catch (error) {
			rules = previousRules;
			loadState = "error";
			errorKind = "save";
			errorMessage = error instanceof Error ? error.message : "通知設定を保存できませんでした";
		} finally {
			saving = false;
			options.onChange();
		}
	};

	const exportAssignments = (assignments: Assignment[]): void => {
		const exportable = exportableAssignments(assignments);
		if (exportable.length === 0) return;
		download(buildDeadlineIcs(exportable), deadlineIcsFileName(new Date(now())));
		exportMessage = `${exportable.length}件の締切をICSファイルに書き出しました。`;
		options.onChange();
	};

	const render = (assignments: Assignment[]): HTMLElement => {
		const panel = element("section", "fuzzy-calendar-panel");
		const exportableCount = exportableAssignments(assignments).length;
		panel.append(buildExportArea(assignments, exportableCount), buildNotificationArea());
		return panel;
	};

	const buildExportArea = (assignments: Assignment[], exportableCount: number): HTMLElement => {
		const area = element("div", "fuzzy-calendar-export");
		const copy = element("div");
		copy.append(
			element("h2", "", "カレンダーへ追加"),
			element(
				"p",
				"fuzzy-calendar-copy",
				"期限が確認できる課題を、提出済み・期限切れも含めてICSファイルにまとめます。",
			),
		);
		const button = element("button", "fuzzy-calendar-button", "ICSを書き出す");
		button.type = "button";
		button.disabled = exportableCount === 0;
		button.addEventListener("click", () => exportAssignments(assignments));
		const status = element(
			"p",
			"fuzzy-calendar-status",
			exportMessage ?? `書き出し対象: ${exportableCount}件`,
		);
		status.setAttribute("aria-live", "polite");
		area.append(copy, button, status);
		return area;
	};

	const buildNotificationArea = (): HTMLElement => {
		const area = element("div", "fuzzy-notification-settings");
		area.append(
			element("h2", "", "締切通知"),
			element(
				"p",
				"fuzzy-calendar-copy",
				"通知したいタイミングを個別に選べます。期限が確認できる未提出の課題だけを通知します。",
			),
		);

		if (loadState === "loading" || loadState === "idle") {
			area.append(element("p", "fuzzy-calendar-status", "通知設定を読み込んでいます…"));
		} else if (loadState === "error" && errorMessage) {
			area.append(buildError());
		} else {
			area.append(buildRuleList());
			if (saving) {
				area.append(element("p", "fuzzy-calendar-status", "通知設定を保存しています…"));
			}
			if (api.mode === "mock") {
				area.append(
					element(
						"p",
						"fuzzy-calendar-status is-mock",
						"サンプルモードです。変更は拡張機能の再起動後にリセットされます。",
					),
				);
			}
		}
		return area;
	};

	const buildError = (): HTMLElement => {
		const error = element("div", "fuzzy-calendar-error");
		const retry = element("button", "fuzzy-calendar-button is-secondary", "再読み込み");
		retry.type = "button";
		retry.addEventListener("click", retryLoad);
		const action = errorKind === "save" ? "保存" : "取得";
		error.append(element("p", "", `通知設定を${action}できませんでした: ${errorMessage}`), retry);
		return error;
	};

	const buildRuleList = (): HTMLElement => {
		const list = element("div", "fuzzy-notification-rule-list");
		for (const rule of rules) {
			const label = element("label", "fuzzy-notification-rule");
			const copy = element("span");
			copy.append(element("strong", "", rule.label), element("small", "", "通知する"));
			const checkbox = element("input");
			checkbox.type = "checkbox";
			checkbox.checked = rule.enabled;
			checkbox.disabled = saving;
			checkbox.setAttribute("role", "switch");
			checkbox.setAttribute("aria-label", `${rule.label}の通知`);
			checkbox.addEventListener("change", () => {
				void updateRule(rule.id, checkbox.checked);
			});
			label.append(copy, checkbox);
			list.append(label);
		}
		return list;
	};

	return { ensureNotificationRulesLoaded, render };
}

function downloadIcsFile(content: string, fileName: string): void {
	const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	link.hidden = true;
	document.body.append(link);
	link.click();
	link.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 0);
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
