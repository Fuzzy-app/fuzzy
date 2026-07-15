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

	suggestSavePath(request: SuggestSavePathRequest): Promise<SaveSuggestion[]>;

	checkSimilarFiles(request: CheckSimilarFilesRequest): Promise<SimilarFileMatch[]>;

	saveFiles(request: SaveFilesRequest): Promise<SaveFilesResult>;

	extractZip(request: ExtractZipRequest): Promise<ExtractZipResult>;

	getRules(): Promise<RuleSet>;

	updateGlobalRule(request: UpdateGlobalRuleRequest): Promise<RuleUpdateResult>;

	updateCourseRuleOverride(request: UpdateCourseRuleOverrideRequest): Promise<RuleUpdateResult>;

	getRuleViolations(): Promise<RuleViolation[]>;

	getDuplicateGroups(): Promise<DuplicateGroup[]>;

	getNotificationRules(): Promise<NotificationRule[]>;

	updateNotificationRules(rules: NotificationRule[]): Promise<{ ok: boolean }>;

	/** 直近の同期（Moodleからのデータ取得）結果。データ取得通知の表示に使う。同期実績が無ければnull */
	getLatestSyncEvent(): Promise<DataSyncEvent | null>;

	/** 同期で検出された課題の変更点一覧。sinceSyncEventId省略時は直近の同期分を返す */
	getAssignmentChanges(sinceSyncEventId?: number): Promise<AssignmentChange[]>;
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
