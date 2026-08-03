import type {
	Assignment,
	AssignmentChange,
	CheckSimilarFilesRequest,
	DashboardSummary,
	DataSyncEvent,
	DeadlineFilter,
	DuplicateGroupListItem,
	ExcludedFolder,
	ExportDataRequest,
	ExportDataResult,
	ExtractZipRequest,
	ExtractZipResult,
	ImportDataRequest,
	ImportDataResult,
	LibraryMaintenanceSummary,
	NotificationRule,
	NotificationRuleInput,
	NotificationRuleUpdateResult,
	OpenFileRequest,
	OpenFileResult,
	RebuildLibraryRequest,
	ReconcileCourseFilesRequest,
	RuleSet,
	RuleUpdateResult,
	RuleViolationListItem,
	SaveFilesRequest,
	SaveFilesResult,
	SaveSuggestion,
	SearchResult,
	SearchScope,
	SimilarFileMatch,
	SuggestSavePathRequest,
	SyncMoodleAssignmentsRequest,
	UpdateCourseFolderNameRequest,
	UpdateCourseFolderNameResult,
	UpdateCourseRuleOverrideRequest,
	UpdateExcludedFoldersRequest,
	UpdateGlobalRuleRequest,
} from "../types";

/**
 * 拡張機能・初期セットアップアプリが利用するAPIの共通インターフェース。
 * 実装は2種類:
 *  - NativeApiClient: Native Messaging経由で native-host と通信する本番実装
 *  - MockApiClient:   テスト・画面開発で明示利用するサンプル実装
 *
 * 本番ではnative-host未接続をエラーとして扱い、MockApiClientへ暗黙に切り替えない。
 */
export interface FuzzyApiClient {
	/** "native" = 実バックエンドに接続中 / "mock" = 明示的な開発用サンプル */
	readonly mode: "native" | "mock";

	ping(): Promise<boolean>;

	getDashboard(): Promise<DashboardSummary>;

	getDeadlines(filter?: DeadlineFilter): Promise<Assignment[]>;

	updateSubmissionStatus(assignmentId: number, submitted: boolean): Promise<{ ok: boolean }>;

	search(query: string, scope?: SearchScope): Promise<SearchResult[]>;

	/** 検索結果の資料を利用者の明示操作で既定アプリへ開く */
	openFile(request: OpenFileRequest): Promise<OpenFileResult>;

	suggestSavePath(request: SuggestSavePathRequest): Promise<SaveSuggestion[]>;

	checkSimilarFiles(request: CheckSimilarFilesRequest): Promise<SimilarFileMatch[]>;

	saveFiles(request: SaveFilesRequest): Promise<SaveFilesResult>;

	extractZip(request: ExtractZipRequest): Promise<ExtractZipResult>;

	getRules(): Promise<RuleSet>;

	updateGlobalRule(request: UpdateGlobalRuleRequest): Promise<RuleUpdateResult>;

	updateCourseRuleOverride(request: UpdateCourseRuleOverrideRequest): Promise<RuleUpdateResult>;
	clearCourseRuleOverride(courseId: number): Promise<RuleUpdateResult>;
	getExcludedFolders(courseId?: number): Promise<ExcludedFolder[]>;
	updateExcludedFolders(request: UpdateExcludedFoldersRequest): Promise<ExcludedFolder[]>;

	updateCourseFolderName(
		request: UpdateCourseFolderNameRequest,
	): Promise<UpdateCourseFolderNameResult>;

	getRuleViolations(): Promise<RuleViolationListItem[]>;

	getDuplicateGroups(): Promise<DuplicateGroupListItem[]>;

	getNotificationRules(): Promise<NotificationRule[]>;

	updateNotificationRules(rules: NotificationRuleInput[]): Promise<NotificationRuleUpdateResult>;

	/** Moodleコースページから得た課題の完全snapshotをSQLiteへ同期する。 */
	syncMoodleAssignments(request: SyncMoodleAssignmentsRequest): Promise<DataSyncEvent>;

	/** 直近の同期（Moodleからのデータ取得）結果。データ取得通知の表示に使う。同期実績が無ければnull */
	getLatestSyncEvent(): Promise<DataSyncEvent | null>;

	/** 同期で検出された課題の変更点一覧。sinceSyncEventId省略時は直近の同期分を返す */
	getAssignmentChanges(sinceSyncEventId?: number): Promise<AssignmentChange[]>;

	/** SQLite正本を生SQLiteバックアップとして書き出す。全文索引は含めない */
	exportData(request: ExportDataRequest): Promise<ExportDataResult>;

	/** SQLiteバックアップを読み込み、再スキャンが必要なことを返す */
	importData(request: ImportDataRequest): Promise<ImportDataResult>;

	/** 保存ルートを再走査し、SQLite注釈と全文索引を実ファイルへ整合させる */
	rebuildLibrary(request: RebuildLibraryRequest): Promise<LibraryMaintenanceSummary>;

	/** Moodleで表示中の1コースに限定し、新規・更新・欠損を差分反映する */
	reconcileCourseFiles(request: ReconcileCourseFilesRequest): Promise<LibraryMaintenanceSummary>;
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
