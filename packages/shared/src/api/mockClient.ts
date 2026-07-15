import assignmentChanges from "../sample-data/assignment-changes.json" with { type: "json" };
import courses from "../sample-data/courses.json" with { type: "json" };
import dashboard from "../sample-data/dashboard.json" with { type: "json" };
import deadlines from "../sample-data/deadlines.json" with { type: "json" };
import duplicateGroups from "../sample-data/duplicate-groups.json" with { type: "json" };
import notificationRules from "../sample-data/notification-rules.json" with { type: "json" };
import ruleViolations from "../sample-data/rule-violations.json" with { type: "json" };
import rules from "../sample-data/rules.json" with { type: "json" };
import searchResults from "../sample-data/search-results.json" with { type: "json" };
import syncEvents from "../sample-data/sync-events.json" with { type: "json" };
import type {
	Assignment,
	AssignmentChange,
	CheckSimilarFilesRequest,
	DashboardSummary,
	DataSyncEvent,
	DeadlineFilter,
	DuplicateGroup,
	ExtractZipRequest,
	ExtractZipResult,
	NotificationRule,
	RuleSet,
	RuleViolation,
	SaveFilesRequest,
	SaveFilesResult,
	SaveSuggestion,
	SearchResult,
	SimilarFileMatch,
	SuggestSavePathRequest,
} from "../types";
import type { FuzzyApiClient } from "./client";

const LATENCY_MS = 30;
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
	private notificationRules: NotificationRule[] = notificationRules as NotificationRule[];

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
		const knownCourse = (courses as { id: number; name: string }[]).find(
			(c) => c.name === request.course.name,
		);
		const knownCourseNames = (courses as { id: number; name: string }[]).map(
			(course) => course.name,
		);
		const courseLabel = courseFolderName(
			knownCourse?.name ?? request.course.name ?? "不明なコース",
			knownCourseNames,
		);
		const sectionLabel = folderSegment(
			request.fileMeta?.sectionTitle ?? request.course.sectionTitle ?? "",
		);
		const coursePath = `C:\\Users\\sample\\Documents\\大学\\2026前期\\${courseLabel}`;
		const suggestions: SaveSuggestion[] = [{ path: coursePath, confidence: 0.92 }];

		// 「授業計画」のような活動名を保存先フォルダにすると、資料を分類するどころか
		// 一件ごとの不要な階層になってしまう。回次・週次のように整理単位として明確な場合だけ、
		// 補助候補として提示する。
		if (sectionLabel && /^(第\s*\d+\s*回|week\s*\d+|\d+週目)/i.test(sectionLabel)) {
			suggestions.push({ path: `${coursePath}\\${sectionLabel}`, confidence: 0.6 });
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
		return delay(rules as RuleSet);
	}

	async getRuleViolations(): Promise<RuleViolation[]> {
		return delay(ruleViolations as RuleViolation[]);
	}

	async getDuplicateGroups(): Promise<DuplicateGroup[]> {
		return delay(duplicateGroups as DuplicateGroup[]);
	}

	async getNotificationRules(): Promise<NotificationRule[]> {
		return delay(this.notificationRules);
	}

	async updateNotificationRules(rules: NotificationRule[]): Promise<{ ok: boolean }> {
		this.notificationRules = rules;
		return delay({ ok: true });
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
}

/**
 * Moodle のコース名に付く年度・担当者などの補足を、保存先フォルダ名には含めない。
 * 同名になる場合でも、候補に表示する名前は簡潔な表記を優先する。
 */
export function courseFolderName(
	courseName: string,
	_knownCourseNames: readonly string[] = [],
): string {
	const original = normalizeCourseName(courseName) || "不明なコース";
	const simplified = removeParentheticalNotes(original);
	return simplified || original;
}

/** 保存先候補に使うフォルダ名から、絵文字と括弧内の補足を取り除く。 */
export function folderSegment(value: string): string {
	return removeParentheticalNotes(normalizeCourseName(value));
}

function removeParentheticalNotes(value: string): string {
	return value
		.replace(/\s*[（(][^（）()]*[）)]\s*/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
}

function normalizeCourseName(value: string): string {
	return value
		.replace(/(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\uFE0F|\u200D|\u20E3)/gu, "")
		.replace(/\s+/g, " ")
		.trim();
}
