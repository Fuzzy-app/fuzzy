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

/**
 * 拡張機能・初期セットアップアプリが利用するAPIの共通インターフェース。
 * 実装は2種類:
 *  - NativeApiClient: Native Messaging経由で native-host と通信する本番実装
 *  - MockApiClient:   サンプルデータを返すフォールバック実装（native-host未起動時）
 *
 * 画面側のコードはこのインターフェースだけに依存し、どちらの実装かを意識しない。
 */
export interface FuzzyApiClient {
	/** "native" = 実バックエンドに接続中 / "mock" = サンプルデータにフォールバック中 */
	readonly mode: "native" | "mock";

	ping(): Promise<boolean>;

	getDashboard(): Promise<DashboardSummary>;

	getDeadlines(filter?: DeadlineFilter): Promise<Assignment[]>;

	updateSubmissionStatus(assignmentId: number, submitted: boolean): Promise<{ ok: boolean }>;

	search(query: string): Promise<SearchResult[]>;

	suggestSavePath(courseId: number): Promise<SaveSuggestion[]>;

	getRules(): Promise<RuleSet>;

	getRuleViolations(): Promise<RuleViolation[]>;

	getDuplicateGroups(): Promise<DuplicateGroup[]>;

	getNotificationRules(): Promise<NotificationRule[]>;

	updateNotificationRules(rules: NotificationRule[]): Promise<{ ok: boolean }>;
}

export class ApiError extends Error {
	constructor(
		public code: string,
		message: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}
