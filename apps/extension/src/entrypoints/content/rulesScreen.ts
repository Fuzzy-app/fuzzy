import { type CourseDashboardEntry, type RuleSet, removeSectionSegment } from "@fuzzy/shared";
import type { RuleManagementStore } from "../../lib/rules/state";
import { buildCourseRulePanel } from "./courseRulePanel";
import { buildGlobalRulePanel } from "./globalRulePanel";
import {
	buildRulesHeader,
	buildRulesMessage,
	buildSummaryCard,
	element,
} from "./rulesScreenElements";
import {
	type CourseRuleDraft,
	createCourseRuleDraft,
	createScreenPreviewValues,
	dedupeCourses,
	getAvailableCourses,
	patternLabel,
	validateCourseRuleDraft,
	validateRulePattern,
} from "./rulesScreenModel";
import { ensureRulesScreenStyle } from "./rulesScreenStyle";

export interface RuleManagementScreen {
	root: HTMLElement;
	activate(): void;
}

export interface RuleManagementScreenOptions {
	store: RuleManagementStore;
	loadCourses: () => Promise<CourseDashboardEntry[]>;
}

export function createRuleManagementScreen(
	options: RuleManagementScreenOptions,
): RuleManagementScreen {
	ensureRulesScreenStyle();

	const root = element("div", "fuzzy-screen fuzzy-rules-screen");
	const previewValues = createScreenPreviewValues();
	const overrideDrafts = new Map<number, CourseRuleDraft>();
	let globalDraft = "";
	let courses: CourseDashboardEntry[] = [];
	let selectedCourseId: number | null = null;
	let loadingRules = false;
	let loadingCourses = false;
	let rulesLoaded = false;
	let coursesLoaded = false;
	let savingTarget: "global" | number | "add" | null = null;
	let loadPromise: Promise<void> | null = null;
	let message: { kind: "success" | "error"; text: string } | null = null;
	let courseLoadError: string | null = null;

	const clearMessage = () => {
		message = null;
		root.querySelector(".fuzzy-rules-message")?.remove();
	};

	const currentRules = (): RuleSet | null => options.store.snapshot.rules;

	const resetDrafts = (rules: RuleSet) => {
		globalDraft = rules.globalPatternTemplate;
		overrideDrafts.clear();
		for (const override of rules.courseOverrides) {
			overrideDrafts.set(override.courseId, createCourseRuleDraft(override));
		}
	};

	const syncOverrideDraft = (courseId: number, rules: RuleSet) => {
		const override = rules.courseOverrides.find((candidate) => candidate.courseId === courseId);
		if (override) overrideDrafts.set(courseId, createCourseRuleDraft(override));
	};

	const updateSelectedCourse = () => {
		const rules = currentRules();
		const available = getAvailableCourses(courses, rules?.courseOverrides ?? []);
		if (!available.some((course) => course.courseId === selectedCourseId)) {
			selectedCourseId = available[0]?.courseId ?? null;
		}
	};

	const initialize = async () => {
		if (rulesLoaded && coursesLoaded) return;
		loadingRules = !rulesLoaded;
		loadingCourses = !coursesLoaded;
		message = null;
		render();

		const [rulesResult, coursesResult] = await Promise.allSettled([
			rulesLoaded ? Promise.resolve(currentRules()) : options.store.load(),
			coursesLoaded ? Promise.resolve(courses) : options.loadCourses(),
		]);

		loadingRules = false;
		loadingCourses = false;
		if (rulesResult.status === "fulfilled" && rulesResult.value) {
			rulesLoaded = true;
			resetDrafts(rulesResult.value);
		} else if (rulesResult.status === "rejected") {
			message = { kind: "error", text: errorMessage(rulesResult.reason) };
		}

		if (coursesResult.status === "fulfilled") {
			coursesLoaded = true;
			courses = dedupeCourses(coursesResult.value);
			courseLoadError = null;
		} else {
			courseLoadError = errorMessage(coursesResult.reason);
		}

		updateSelectedCourse();
		render();
	};

	const activate = () => {
		if (loadPromise) return;
		loadPromise = initialize().finally(() => {
			loadPromise = null;
		});
	};

	const reloadRules = async () => {
		loadingRules = true;
		message = null;
		render();
		try {
			const rules = await options.store.load();
			rulesLoaded = true;
			resetDrafts(rules);
			updateSelectedCourse();
			message = {
				kind: "success",
				text:
					options.store.mode === "mock"
						? "現在のサンプルルールを読み込みました。"
						: "SQLiteに保存されたルールを読み込みました。",
			};
		} catch (error) {
			message = { kind: "error", text: errorMessage(error) };
		} finally {
			loadingRules = false;
			render();
		}
	};

	const saveGlobalRule = async () => {
		const validationError = validateRulePattern(globalDraft);
		if (validationError) {
			message = { kind: "error", text: validationError };
			render();
			return;
		}

		savingTarget = "global";
		message = null;
		render();
		try {
			const rules = await options.store.updateGlobalRule({ patternTemplate: globalDraft });
			globalDraft = rules.globalPatternTemplate;
			message = {
				kind: "success",
				text:
					options.store.mode === "mock"
						? "サンプルのグローバルルールへ反映しました。"
						: "グローバルルールをSQLiteへ保存しました。",
			};
		} catch (error) {
			message = { kind: "error", text: errorMessage(error) };
		} finally {
			savingTarget = null;
			render();
		}
	};

	const saveCourseOverride = async (courseId: number) => {
		const rules = currentRules();
		const draft = overrideDrafts.get(courseId);
		if (!rules || !draft) return;

		const validationError = validateCourseRuleDraft(draft, rules.globalPatternTemplate);
		if (validationError) {
			message = { kind: "error", text: `${draft.courseName}: ${validationError}` };
			render();
			return;
		}

		savingTarget = courseId;
		message = null;
		render();
		try {
			const nextRules = await options.store.updateCourseRuleOverride({
				courseId,
				override: {
					splitBySection: draft.splitBySection,
					patternTemplate: draft.patternTemplate.trim() || null,
					note: draft.note.trim() || null,
				},
			});
			syncOverrideDraft(courseId, nextRules);
			message = {
				kind: "success",
				text:
					options.store.mode === "mock"
						? `${draft.courseName}のサンプル例外へ反映しました。`
						: `${draft.courseName}の例外ルールをSQLiteへ保存しました。`,
			};
		} catch (error) {
			message = { kind: "error", text: errorMessage(error) };
		} finally {
			savingTarget = null;
			render();
		}
	};

	const addCourseOverride = async () => {
		const rules = currentRules();
		const course = courses.find((candidate) => candidate.courseId === selectedCourseId);
		if (!rules || !course) return;

		const defaultPattern = removeSectionSegment(rules.globalPatternTemplate);
		const validationError = validateCourseRuleDraft(
			{
				courseName: course.courseName,
				splitBySection: false,
				patternTemplate: defaultPattern,
				note: "",
			},
			rules.globalPatternTemplate,
		);
		if (validationError) {
			message = { kind: "error", text: `${course.courseName}: ${validationError}` };
			render();
			return;
		}

		savingTarget = "add";
		message = null;
		render();
		try {
			const nextRules = await options.store.updateCourseRuleOverride({
				courseId: course.courseId,
				override: {
					splitBySection: false,
					patternTemplate: defaultPattern,
					note: "このコースは回ごとに保存しない",
				},
			});
			syncOverrideDraft(course.courseId, nextRules);
			updateSelectedCourse();
			message = {
				kind: "success",
				text:
					options.store.mode === "mock"
						? `${course.courseName}をサンプル例外へ追加しました。`
						: `${course.courseName}をSQLiteの例外ルールへ追加しました。`,
			};
		} catch (error) {
			message = { kind: "error", text: errorMessage(error) };
		} finally {
			savingTarget = null;
			render();
		}
	};

	const buildTabs = (): HTMLElement => {
		const tabs = element("nav", "fuzzy-rules-tabs");
		tabs.setAttribute("aria-label", "整理ルールの表示内容");
		const ruleTab = element("button", "fuzzy-rules-tab is-active", "ルール設定");
		ruleTab.type = "button";
		ruleTab.setAttribute("aria-current", "page");
		const warningTab = element("button", "fuzzy-rules-tab", "警告・未整理ファイル");
		warningTab.type = "button";
		warningTab.disabled = true;
		warningTab.title = "issue #53 でルール違反の一覧へ接続します";
		tabs.append(ruleTab, warningTab);
		return tabs;
	};

	const buildOverview = (rules: RuleSet): HTMLElement => {
		const overview = element("section", "fuzzy-rules-overview");
		overview.append(
			buildSummaryCard(
				"現在のグローバルルール",
				patternLabel(rules.globalPatternTemplate),
				rules.globalPatternTemplate,
				"is-accent",
			),
			buildSummaryCard(
				"コース別例外",
				`${rules.courseOverrides.length}件`,
				"グローバルと違う保存方法だけを保持します。",
			),
			buildSummaryCard(
				"警告への接続",
				"同じルールを利用",
				"issue #53 ではこの保存状態を違反・未整理ファイルの判定基準にします。",
				"is-future",
			),
		);
		return overview;
	};

	function render(): void {
		const rules = currentRules();
		root.replaceChildren(buildRulesHeader(), buildTabs());

		if (rules && options.store.mode === "mock") {
			root.append(
				element(
					"div",
					"fuzzy-rules-message is-mock",
					"サンプルモードです。変更は画面確認用で、拡張機能の再起動後にリセットされます。",
				),
			);
		}
		if (message) root.append(buildRulesMessage(message));
		if (loadingRules && !rules) {
			root.append(element("section", "fuzzy-placeholder", "保存済みルールを読み込んでいます…"));
			return;
		}

		if (!rules) {
			const errorPanel = element("section", "fuzzy-error-panel");
			const retry = element("button", "fuzzy-primary-button", "再読み込み");
			retry.type = "button";
			retry.addEventListener("click", () => {
				rulesLoaded = false;
				activate();
			});
			errorPanel.append(
				element("p", "", options.store.snapshot.error ?? "ルールを読み込めませんでした。"),
				retry,
			);
			root.append(errorPanel);
			return;
		}

		root.append(
			buildOverview(rules),
			buildGlobalRulePanel({
				rules,
				draft: globalDraft,
				previewValues,
				savingTarget,
				loadingRules,
				isMock: options.store.mode === "mock",
				onDraftChange: (value) => {
					globalDraft = value;
				},
				onClearMessage: clearMessage,
				onReload: () => void reloadRules(),
				onSave: () => void saveGlobalRule(),
			}),
			buildCourseRulePanel({
				rules,
				courses,
				drafts: overrideDrafts,
				selectedCourseId,
				loadingCourses,
				courseLoadError,
				savingTarget,
				previewValues,
				isMock: options.store.mode === "mock",
				onSelectedCourseChange: (courseId) => {
					selectedCourseId = courseId;
				},
				onClearMessage: clearMessage,
				onAdd: () => void addCourseOverride(),
				onSave: (courseId) => void saveCourseOverride(courseId),
			}),
		);
	}

	render();
	return { root, activate };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "ルールを更新できませんでした。";
}
