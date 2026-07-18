import {
	type Assignment,
	type FuzzyApiClient,
	MAX_NOTIFICATION_OFFSET_DAYS,
	type NotificationOffsetUnit,
	type NotificationRule,
	type NotificationRuleInput,
	notificationOffsetMinutes,
	notificationRuleLabel,
} from "@fuzzy/shared";
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
	let customAmount = "30";
	let customUnit: NotificationOffsetUnit = "minutes";
	let customError: string | null = null;

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

	const saveRules = async (
		nextRules: NotificationRuleInput[],
		optimisticRules: NotificationRule[] | null,
	): Promise<boolean> => {
		if (saving) return false;
		const previousRules = rules;
		if (optimisticRules) rules = optimisticRules;
		saving = true;
		errorMessage = null;
		options.onChange();

		try {
			const result = await api.updateNotificationRules(nextRules);
			if (!result.ok) throw new Error("通知設定を保存できませんでした");
			rules = result.rules;
			loadState = "loaded";
			return true;
		} catch (error) {
			rules = previousRules;
			loadState = "error";
			errorKind = "save";
			errorMessage = error instanceof Error ? error.message : "通知設定を保存できませんでした";
			return false;
		} finally {
			saving = false;
			options.onChange();
		}
	};

	const updateRule = (ruleId: number, enabled: boolean): Promise<boolean> => {
		const nextRules = rules.map((rule) => (rule.id === ruleId ? { ...rule, enabled } : rule));
		return saveRules(nextRules.map(toNotificationRuleInput), nextRules);
	};

	const deleteRule = (ruleId: number): Promise<boolean> => {
		const nextRules = rules.filter((rule) => rule.id !== ruleId);
		return saveRules(nextRules.map(toNotificationRuleInput), nextRules);
	};

	const addCustomRule = async (): Promise<void> => {
		const amount = Number(customAmount);
		const offsetMinutes = notificationOffsetMinutes(amount, customUnit);
		if (offsetMinutes === null) {
			customError = `0以上の整数で、${MAX_NOTIFICATION_OFFSET_DAYS}日前以内になる値を入力してください。`;
			options.onChange();
			return;
		}
		if (rules.some((rule) => rule.offsetMinutes === offsetMinutes)) {
			customError = `${notificationRuleLabel(offsetMinutes)}はすでに登録されています。`;
			options.onChange();
			return;
		}

		customError = null;
		const saved = await saveRules(
			[
				...rules.map(toNotificationRuleInput),
				{
					offsetMinutes,
					enabled: true,
				},
			],
			null,
		);
		if (saved) {
			customAmount = "30";
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
			area.append(buildRuleList(), buildCustomRuleForm());
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
			const item = element("div", "fuzzy-notification-rule");
			const label = element("label", "fuzzy-notification-toggle");
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
			const deleteButton = element("button", "fuzzy-notification-delete", "削除");
			deleteButton.type = "button";
			deleteButton.disabled = saving;
			deleteButton.setAttribute("aria-label", `${rule.label}の通知を削除`);
			deleteButton.addEventListener("click", () => {
				void deleteRule(rule.id);
			});
			item.append(label, deleteButton);
			list.append(item);
		}
		return list;
	};

	const buildCustomRuleForm = (): HTMLElement => {
		const form = element("form", "fuzzy-notification-custom");
		form.append(element("strong", "", "任意のタイミングを追加"));
		const fields = element("div", "fuzzy-notification-custom-fields");
		const amountInput = element("input");
		amountInput.type = "number";
		amountInput.min = "0";
		amountInput.step = "1";
		amountInput.value = customAmount;
		amountInput.disabled = saving;
		amountInput.setAttribute("aria-label", "通知タイミングの数値");
		amountInput.addEventListener("input", () => {
			customAmount = amountInput.value;
		});
		const unitSelect = element("select");
		unitSelect.disabled = saving;
		unitSelect.setAttribute("aria-label", "通知タイミングの単位");
		for (const [value, label] of [
			["minutes", "分前"],
			["hours", "時間前"],
			["days", "日前"],
		] as const) {
			const option = element("option", "", label);
			option.value = value;
			option.selected = value === customUnit;
			unitSelect.append(option);
		}
		unitSelect.addEventListener("change", () => {
			customUnit = unitSelect.value as NotificationOffsetUnit;
		});
		const addButton = element("button", "fuzzy-calendar-button", "追加");
		addButton.type = "submit";
		addButton.disabled = saving;
		fields.append(amountInput, unitSelect, addButton);
		form.append(
			fields,
			element(
				"small",
				"",
				`0なら締切時刻、最大${MAX_NOTIFICATION_OFFSET_DAYS}日前まで設定できます。`,
			),
		);
		if (customError) {
			const error = element("p", "fuzzy-notification-custom-error", customError);
			error.setAttribute("aria-live", "polite");
			form.append(error);
		}
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			void addCustomRule();
		});
		return form;
	};

	return { ensureNotificationRulesLoaded, render };
}

function toNotificationRuleInput(rule: NotificationRule): NotificationRuleInput {
	return {
		id: rule.id,
		offsetMinutes: rule.offsetMinutes,
		enabled: rule.enabled,
	};
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
