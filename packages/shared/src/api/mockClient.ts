import courses from "../sample-data/courses.json" with {type: "json"};
import dashboard from "../sample-data/dashboard.json" with {type: "json"};
import deadlines from "../sample-data/deadlines.json" with {type: "json"};
import duplicateGroups from "../sample-data/duplicate-groups.json" with {type: "json"};
import notificationRules from "../sample-data/notification-rules.json" with {type: "json"};
import ruleViolations from "../sample-data/rule-violations.json" with {type: "json"};
import rules from "../sample-data/rules.json" with {type: "json"};
import searchResults from "../sample-data/search-results.json" with {type: "json"};
import type {FuzzyApiClient} from "./client";
import type {
	Assignment,
	DashboardSummary,
	DeadlineFilter,
	DuplicateGroup,
	NotificationRule,
	RuleSet,
	RuleViolation,
	SaveSuggestion,
	SearchResult,
} from "../types";

const LATENCY_MS = 30;
const delay = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), LATENCY_MS));

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
			result = result.filter((a) => !a.dueAt || new Date(a.dueAt).getTime() >= now || a.submitted === false);
		}
		return delay(result);
	}

	async updateSubmissionStatus(assignmentId: number, submitted: boolean): Promise<{ ok: boolean }> {
		this.deadlines = this.deadlines.map((a) => (a.id === assignmentId ? {...a, submitted} : a));
		return delay({ok: true});
	}

	async search(query: string): Promise<SearchResult[]> {
		const table = searchResults as Record<string, SearchResult[]>;
		return delay(table[query] ?? []);
	}

	async suggestSavePath(courseId: number): Promise<SaveSuggestion[]> {
		const course = (courses as { id: number; name: string }[]).find((c) => c.id === courseId);
		const courseLabel = course?.name ?? "不明なコース";
		return delay([
			{path: `C:\\Users\\sample\\Documents\\大学\\2026前期\\${courseLabel}\\第10回`, confidence: 0.92},
			{path: `C:\\Users\\sample\\Documents\\大学\\2026前期\\${courseLabel}`, confidence: 0.6},
		]);
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
		return delay({ok: true});
	}
}
