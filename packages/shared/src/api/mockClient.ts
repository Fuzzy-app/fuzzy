import { isValidNotificationOffsetMinutes, notificationRuleLabel } from "../notificationRules";
import {
	createRulePreviewValues,
	removeSectionSegment,
	resolveRulePattern,
	validateCourseRuleOverride,
	validateRulePattern,
} from "../rules";
import assignmentChanges from "../sample-data/assignment-changes.json" with { type: "json" };
import courses from "../sample-data/courses.json" with { type: "json" };
import dashboard from "../sample-data/dashboard.json" with { type: "json" };
import deadlines from "../sample-data/deadlines.json" with { type: "json" };
import duplicateGroups from "../sample-data/duplicate-groups.json" with { type: "json" };
import notificationRules from "../sample-data/notification-rules.json" with { type: "json" };
import ruleViolations from "../sample-data/rule-violations.json" with { type: "json" };
import sampleRules from "../sample-data/rules.json" with { type: "json" };
import searchResults from "../sample-data/search-results.json" with { type: "json" };
import syncEvents from "../sample-data/sync-events.json" with { type: "json" };
import { normalizeWindowsPath } from "../savePaths";
import type {
	Assignment,
	AssignmentChange,
	CheckSimilarFilesRequest,
	Course,
	CourseRuleOverride,
	CourseRuleOverrideInput,
	DashboardSummary,
	DataSyncEvent,
	DeadlineFilter,
	DuplicateGroup,
	ExtractZipRequest,
	ExtractZipResult,
	NotificationRule,
	NotificationRuleInput,
	NotificationRuleUpdateResult,
	RuleSet,
	RuleUpdateResult,
	RuleViolation,
	SaveFilesRequest,
	SaveFilesResult,
	SaveSuggestion,
	SearchResult,
	SimilarFileMatch,
	SuggestSavePathRequest,
	UpdateCourseRuleOverrideRequest,
	UpdateGlobalRuleRequest,
} from "../types";
import { ApiError, type FuzzyApiClient } from "./client";

const LATENCY_MS = 30;
const MOCK_SAVE_ROOT = "C:\\Users\\sample\\Documents\\大学";
const delay = <T>(value: T) =>
	new Promise<T>((resolve) => setTimeout(() => resolve(value), LATENCY_MS));

/**
 * native-host が起動していない場合に使うモック実装。
 * バンドルされたサンプルデータ（sample-data/*.json）を返す。
 * 画面開発・デモ・テストを native-host 未実装の状態でも進められるようにするためのもの。
 */
export class MockApiClient implements FuzzyApiClient {
	readonly mode = "mock" as const;

	// 更新系コマンドの結果をプロセス内に保持し、デモ中の見た目の一貫性を保つ
	private deadlines: Assignment[] = deadlines as Assignment[];
	private notificationRules: NotificationRule[] = (notificationRules as NotificationRule[]).map(
		(rule) => ({
			...rule,
			label: notificationRuleLabel(rule.offsetMinutes),
		}),
	);
	private nextNotificationRuleId =
		this.notificationRules.reduce((max, rule) => Math.max(max, rule.id), 0) + 1;
	private rules: RuleSet = cloneRuleSet(sampleRules as RuleSet);
	private ruleMutationQueue: Promise<void> = Promise.resolve();

	async ping(): Promise<boolean> {
		return delay(true);
	}

	async getDashboard(): Promise<DashboardSummary> {
		return delay(dashboard as DashboardSummary);
	}

	async getDeadlines(filter?: DeadlineFilter): Promise<Assignment[]> {
		let result = this.deadlines;
		if (filter?.courseId !== undefined) {
			result = result.filter((a) => a.courseId === filter.courseId);
		}
		if (filter?.needsReviewOnly) {
			result = result.filter((a) => a.dueAtStatus === "needs_review");
		}
		if (!filter?.includePast) {
			const now = Date.now();
			result = result.filter(
				(a) => !a.dueAt || new Date(a.dueAt).getTime() >= now || a.submitted === false,
			);
		}
		return delay(result);
	}

	async updateSubmissionStatus(assignmentId: number, submitted: boolean): Promise<{ ok: boolean }> {
		this.deadlines = this.deadlines.map((a) => (a.id === assignmentId ? { ...a, submitted } : a));
		return delay({ ok: true });
	}

	async search(query: string): Promise<SearchResult[]> {
		const table = searchResults as Record<string, SearchResult[]>;
		return delay(table[query] ?? []);
	}

	async suggestSavePath(request: SuggestSavePathRequest): Promise<SaveSuggestion[]> {
		const knownCourse = (courses as Course[]).find((course) => course.name === request.course.name);
		const courseLabel = knownCourse?.name ?? request.course.name ?? "不明なコース";
		const sectionLabel = request.fileMeta?.sectionTitle ?? request.course.sectionTitle;
		const section = extractSectionNumber(sectionLabel);
		const fallbackValues = createRulePreviewValues();
		const term =
			knownCourse?.term ??
			request.course.breadcrumbs.find((item) => /^\d{4}(?:前期|後期|通年)$/.test(item)) ??
			fallbackValues.term;
		const override = knownCourse
			? this.rules.courseOverrides.find((candidate) => candidate.courseId === knownCourse.id)
			: undefined;
		let patternTemplate = override?.patternTemplate ?? this.rules.globalPatternTemplate;
		if (override?.splitBySection === false || (!section && patternTemplate.includes("{section}"))) {
			patternTemplate = removeSectionSegment(patternTemplate);
		}

		const values = {
			...fallbackValues,
			year: term.match(/^\d{4}/)?.[0] ?? fallbackValues.year,
			term,
			course: courseLabel,
			assignment: request.fileMeta?.title.replace(/\.[a-z0-9]{1,10}$/i, "") ?? "資料",
			section: section ?? fallbackValues.section,
		};
		const primaryRelativePath = resolveRulePattern(patternTemplate, values);
		const suggestions: SaveSuggestion[] = [createSaveSuggestion(primaryRelativePath, 0.92)];

		// 回ごとの候補が最有力の場合も、ユーザーが科目直下へまとめられるよう補助候補を返す。
		if (section && patternTemplate.includes("{section}")) {
			const courseRelativePath = resolveRulePattern(removeSectionSegment(patternTemplate), values);
			if (courseRelativePath !== primaryRelativePath) {
				suggestions.push(createSaveSuggestion(courseRelativePath, 0.6));
			}
		}

		return delay(suggestions);
	}

	async checkSimilarFiles(request: CheckSimilarFilesRequest): Promise<SimilarFileMatch[]> {
		const title = request.fileMeta.title;
		if (/正規化|第4回|normal/i.test(title)) {
			return delay([
				{
					fileId: 204,
					originalName: "第04回_正規化.pdf",
					similarity: 0.88,
				},
			]);
		}
		if (/演習|exercise/i.test(title)) {
			return delay([
				{
					fileId: 317,
					originalName: "演習問題_解答例.docx",
					similarity: 0.74,
				},
			]);
		}
		return delay([]);
	}

	async saveFiles(request: SaveFilesRequest): Promise<SaveFilesResult> {
		return delay({
			savedFileIds: request.files.map((file, index) => file.moodleFileId ?? `${index + 1}`),
		});
	}

	async extractZip(request: ExtractZipRequest): Promise<ExtractZipResult> {
		const basePath = request.destinationPath || request.targetPath;
		return delay({
			extractedPaths: [
				request.flatten ? `${basePath}\\第1回_資料.pdf` : `${basePath}\\contents\\第1回_資料.pdf`,
				request.flatten ? `${basePath}\\演習データ.csv` : `${basePath}\\contents\\演習データ.csv`,
			],
		});
	}

	async getRules(): Promise<RuleSet> {
		return delay(cloneRuleSet(this.rules));
	}

	async updateGlobalRule(request: UpdateGlobalRuleRequest): Promise<RuleUpdateResult> {
		if (!request || typeof request.patternTemplate !== "string") {
			throw new ApiError("RULE_CONFLICT", "グローバルルールを入力してください。");
		}
		const patternTemplate = request.patternTemplate.trim();
		const patternError = validateRulePattern(patternTemplate);
		if (patternError) throw new ApiError("RULE_CONFLICT", patternError);

		return this.enqueueRuleMutation(() => {
			for (const override of this.rules.courseOverrides) {
				const consistencyError = validateCourseRuleOverride(override, patternTemplate);
				if (consistencyError) {
					throw new ApiError(
						"RULE_CONFLICT",
						`${override.courseName}の例外ルールと矛盾しています: ${consistencyError}`,
					);
				}
			}
			this.rules = { ...this.rules, globalPatternTemplate: patternTemplate };
		});
	}

	async updateCourseRuleOverride(
		request: UpdateCourseRuleOverrideRequest,
	): Promise<RuleUpdateResult> {
		if (!request || !Number.isInteger(request.courseId) || request.courseId <= 0) {
			throw new ApiError("NOT_FOUND", "コースを選択してください。");
		}
		const override = normalizeCourseRuleOverrideInput(request.override);

		return this.enqueueRuleMutation(() => {
			const course = (dashboard as DashboardSummary).courses.find(
				(candidate) => candidate.courseId === request.courseId,
			);
			if (!course) throw new ApiError("NOT_FOUND", "対象のコースが見つかりません。");
			const consistencyError = validateCourseRuleOverride(
				override,
				this.rules.globalPatternTemplate,
			);
			if (consistencyError) throw new ApiError("RULE_CONFLICT", consistencyError);

			const nextOverride: CourseRuleOverride = {
				courseId: request.courseId,
				courseName: course.courseName,
				...override,
			};
			const existingIndex = this.rules.courseOverrides.findIndex(
				(candidate) => candidate.courseId === request.courseId,
			);
			const courseOverrides = this.rules.courseOverrides.map((candidate) => ({ ...candidate }));
			if (existingIndex === -1) courseOverrides.push(nextOverride);
			else courseOverrides[existingIndex] = nextOverride;
			this.rules = { ...this.rules, courseOverrides };
		});
	}

	async getRuleViolations(): Promise<RuleViolation[]> {
		return delay(ruleViolations as RuleViolation[]);
	}

	async getDuplicateGroups(): Promise<DuplicateGroup[]> {
		return delay(duplicateGroups as DuplicateGroup[]);
	}

	async getNotificationRules(): Promise<NotificationRule[]> {
		return delay(this.notificationRules.map((rule) => ({ ...rule })));
	}

	async updateNotificationRules(
		rules: NotificationRuleInput[],
	): Promise<NotificationRuleUpdateResult> {
		const knownIds = new Set(this.notificationRules.map((rule) => rule.id));
		const offsets = new Set<number>();
		for (const rule of rules) {
			if (typeof rule.enabled !== "boolean") {
				throw new ApiError("RULE_CONFLICT", "通知の有効・無効を選択してください。");
			}
			if (!isValidNotificationOffsetMinutes(rule.offsetMinutes)) {
				throw new ApiError(
					"RULE_CONFLICT",
					"通知タイミングは締切時刻から365日前までの整数で指定してください。",
				);
			}
			if (offsets.has(rule.offsetMinutes)) {
				throw new ApiError("RULE_CONFLICT", "同じ通知タイミングは重複して登録できません。");
			}
			if (rule.id !== undefined && !knownIds.has(rule.id)) {
				throw new ApiError("NOT_FOUND", "更新対象の通知ルールが見つかりません。");
			}
			offsets.add(rule.offsetMinutes);
		}
		this.notificationRules = rules.map((rule) => ({
			...rule,
			id: rule.id ?? this.nextNotificationRuleId++,
			label: notificationRuleLabel(rule.offsetMinutes),
		}));
		return delay({ ok: true, rules: this.notificationRules.map((rule) => ({ ...rule })) });
	}

	async getLatestSyncEvent(): Promise<DataSyncEvent | null> {
		const events = syncEvents as DataSyncEvent[];
		return delay(events[events.length - 1] ?? null);
	}

	async getAssignmentChanges(sinceSyncEventId?: number): Promise<AssignmentChange[]> {
		// サンプルデータは直近の同期（sync_events末尾）1回分の変更点のみを保持している。
		// sinceSyncEventIdがそれより新しい同期を指す場合は差分なしとして扱う
		const events = syncEvents as DataSyncEvent[];
		const latestId = events[events.length - 1]?.id;
		if (sinceSyncEventId !== undefined && latestId !== undefined && sinceSyncEventId >= latestId) {
			return delay([]);
		}
		return delay(assignmentChanges as AssignmentChange[]);
	}

	private async enqueueRuleMutation(mutate: () => void): Promise<RuleUpdateResult> {
		const operation = this.ruleMutationQueue.then(async () => {
			mutate();
			await delay(undefined);
		});
		this.ruleMutationQueue = operation.catch(() => undefined);
		await operation;
		return { ok: true };
	}
}

function normalizeCourseRuleOverrideInput(value: unknown): CourseRuleOverrideInput {
	if (!value || typeof value !== "object") {
		throw new ApiError("RULE_CONFLICT", "コース別例外を入力してください。");
	}
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.splitBySection !== "boolean") {
		throw new ApiError("RULE_CONFLICT", "回ごとの整理方法を選択してください。");
	}
	if (candidate.patternTemplate !== null && typeof candidate.patternTemplate !== "string") {
		throw new ApiError("RULE_CONFLICT", "例外ルールを入力してください。");
	}
	if (candidate.note !== null && typeof candidate.note !== "string") {
		throw new ApiError("RULE_CONFLICT", "メモを文字列で入力してください。");
	}
	return {
		splitBySection: candidate.splitBySection,
		patternTemplate:
			typeof candidate.patternTemplate === "string"
				? candidate.patternTemplate.trim() || null
				: null,
		note: typeof candidate.note === "string" ? candidate.note.trim() || null : null,
	};
}

function cloneRuleSet(rules: RuleSet): RuleSet {
	return {
		globalPatternTemplate: rules.globalPatternTemplate,
		courseOverrides: rules.courseOverrides.map((override) => ({ ...override })),
	};
}

function createSaveSuggestion(relativePath: string, confidence: number): SaveSuggestion {
	const normalizedRelativePath = normalizeWindowsPath(relativePath);
	return {
		path: `${MOCK_SAVE_ROOT}\\${normalizedRelativePath}`,
		relativePath: normalizedRelativePath,
		confidence,
	};
}

function extractSectionNumber(sectionTitle: string | null): string | null {
	const normalized = sectionTitle?.normalize("NFKC").trim() ?? "";
	const match = normalized.match(/(?:第\s*)?(\d{1,3})\s*(?:回|週目?|week)|week\s*(\d{1,3})/i);
	return match?.[1] ?? match?.[2] ?? null;
}
