// Rust DTOが存在するAPI型はts-rs生成物を使用する。
// packages/shared/src/generated/ は `bun run generate:types` で再生成し、手編集しない。
import type { CourseFolderNameResolution } from "./generated/CourseFolderNameResolution";

export type { CourseFolderNameResolution } from "./generated/CourseFolderNameResolution";
export type { CourseFolderNameWarning } from "./generated/CourseFolderNameWarning";
export type { CourseFolderNameWarningCode } from "./generated/CourseFolderNameWarningCode";
export type { DuplicateFileListItem } from "./generated/DuplicateFileListItem";
export type { DuplicateGroupListItem } from "./generated/DuplicateGroupListItem";
export type { DuplicateMethod } from "./generated/DuplicateMethod";
export type { DataSyncEvent } from "./generated/DataSyncEvent";
export type { ExportDataRequest } from "./generated/ExportDataRequest";
export type { ExportDataResult } from "./generated/ExportDataResult";
export type { ExtensionRecoveryState } from "./generated/ExtensionRecoveryState";
export type { ExtensionRecoveryStatus } from "./generated/ExtensionRecoveryStatus";
export type { ExtensionRuntimeObservation } from "./generated/ExtensionRuntimeObservation";
export type { ExtensionRuntimeReport } from "./generated/ExtensionRuntimeReport";
export type { ExtensionSetupState } from "./generated/ExtensionSetupState";
export type { ExtensionSetupStatus } from "./generated/ExtensionSetupStatus";
export type { ImportDataRequest } from "./generated/ImportDataRequest";
export type { ImportDataResult } from "./generated/ImportDataResult";
export type { LibraryMaintenanceSummary } from "./generated/LibraryMaintenanceSummary";
export type { LibraryMaintenanceWarning } from "./generated/LibraryMaintenanceWarning";
export type { PingResult } from "./generated/PingResult";
export type { ReconcileCourseFilesRequest } from "./generated/ReconcileCourseFilesRequest";
export type { RebuildLibraryRequest } from "./generated/RebuildLibraryRequest";
export type { RuleViolationListItem } from "./generated/RuleViolationListItem";
export type { SearchRequest } from "./generated/SearchRequest";
export type { SearchResult } from "./generated/SearchResult";
export type { SyncMoodleAssignmentRequest } from "./generated/SyncMoodleAssignmentRequest";
export type { SyncMoodleAssignmentsRequest } from "./generated/SyncMoodleAssignmentsRequest";
export type { SyncMoodleCourseRequest } from "./generated/SyncMoodleCourseRequest";
export type { UpdateCourseFolderNameRequest } from "./generated/UpdateCourseFolderNameRequest";
export type { UpdateCourseFolderNameResult } from "./generated/UpdateCourseFolderNameResult";

export interface Course {
	id: number;
	moodleCourseId: string;
	/** backendがMoodle文脈から確定した年度。term文字列からクライアント側で推測しない。 */
	academicYear: number | null;
	name: string;
	term: string | null;
	/** backendがNFKC正規化・衝突回避・ユーザー上書きを適用した保存用フォルダ名。 */
	folderName: string;
}

export interface SimilarFileMatch {
	fileId: number;
	originalName: string;
	similarity: number;
}

export interface SaveSuggestion {
	/** native-hostが保存に使用する、初期設定の保存ルートを含む絶対パス。 */
	path: string;
	/** UI表示・手動編集に使用する、初期設定の保存ルート以下の相対パス。 */
	relativePath: string;
	confidence: number; // 0.0〜1.0、確からしさ順の表示に使う
	similarMatches?: SimilarFileMatch[];
	/** 保存先に使用したコースフォルダ名と、確認が必要な警告。 */
	courseFolder: CourseFolderNameResolution;
}

/** 初期走査で推定した、利用者確認前の保存構造候補。 */
export interface InitialScanPatternCandidate {
	id: string;
	name: string;
	description: string;
	/** この候補を実際に支持した相対フォルダーパスの代表例。 */
	folders: string[];
	/** 保存ルート直下から数えた科目セグメント位置。未分類ではnull。 */
	courseSegmentIndex: number | null;
	/** 比較評価用のファイル名規則。DBの保存ルールには自動保存しない。 */
	fileNameTemplate: string | null;
	/** 評価可能な母集団に対する一致度。推定不能ではnull。 */
	matchScore: number | null;
	/** この候補を評価できたファイル数。 */
	evaluatedCount: number;
	reason: string;
	recommended: boolean;
	/** 自動選択せず、利用者が明示的に選ぶ必要がある候補か。 */
	requiresConfirmation: boolean;
}

/** Tauriの`library-maintenance-progress`イベント。絶対パスや本文を含めない。 */
export interface LibraryMaintenanceProgress {
	phase: "scanning" | "registering" | "indexing" | "finalizing" | "completed";
	state: "running" | "completed" | "completedWithWarnings" | "failed";
	completedCount: number;
	totalCount: number | null;
	warningCount: number;
}

export interface MoodleCourseContext {
	/** Moodleの安定コースID。フロント移行完了までは省略可能。 */
	moodleCourseId?: string | null;
	name: string | null;
	/** Moodle文脈から抽出した年度。term文字列へ埋め込まず独立して渡す。 */
	academicYear?: number | null;
	/** Moodle文脈から抽出した学期表記。 */
	term?: string | null;
	sectionTitle: string | null;
	breadcrumbs: string[];
}

export type ExcludedFolderScope = "root" | "course";

export interface ExcludedFolder {
	id: number;
	scope: ExcludedFolderScope;
	courseId: number | null;
	relativePath: string;
}

export interface UpdateExcludedFoldersRequest {
	scope: ExcludedFolderScope;
	courseId: number | null;
	paths: string[];
}

export interface MoodleFileMeta {
	title: string;
	url: string;
	moodleFileId: string | null;
	sectionTitle: string | null;
	mimeHint: string | null;
}

export interface SuggestSavePathRequest {
	course: MoodleCourseContext;
	fileMeta: MoodleFileMeta | null;
}

export interface CheckSimilarFilesRequest {
	fileMeta: MoodleFileMeta;
	/** backgroundが認証付き取得後にnative-hostへ渡す。content scriptからは指定しない。 */
	contentBase64?: string;
}

/** content scriptからbackgroundへ渡す、認証付き取得前の保存要求。 */
export interface MoodleSaveFilesRequest {
	files: MoodleFileMeta[];
	targetPath: string;
	courseId: number | null;
}

/** backgroundがMoodleから取得し、native-hostへ分割転送する1ファイル。 */
export interface SaveFilePayload {
	fileId: string;
	fileName: string;
	mimeType: string | null;
	byteLength: number;
	contentBase64: string;
}

/** NativeApiClientへ渡す取得済みファイルの保存要求。 */
export interface SaveFilesRequest {
	files: SaveFilePayload[];
	targetPath: string;
	courseId: number | null;
}

export interface SaveFileFailure {
	fileId: string;
	code: "DOWNLOAD_FAILED" | "INVALID_CONTENT" | "ALREADY_EXISTS" | "IO_ERROR";
}

export interface SaveFilesResult {
	savedFileIds: string[];
	failedFiles: SaveFileFailure[];
}

export interface ExtractZipRequest {
	fileMeta: MoodleFileMeta;
	targetPath: string;
	destinationPath: string;
	flatten: boolean;
}

export interface ExtractZipResult {
	extractedPaths: string[];
}

export type DueAtStatus = "normal" | "needs_review";
export type SubmissionMode = "moodle_auto" | "manual" | "notify_only" | "unknown";

export interface Assignment {
	id: number;
	courseId: number;
	courseName: string;
	title: string;
	source: "moodle_dashboard" | "moodle_text" | "file_content";
	dueAt: string | null; // ISO8601
	dueAtStatus: DueAtStatus;
	submissionMode: SubmissionMode;
	submitted: boolean;
	submissionAvailability: "available" | "unavailable" | "unknown";
	/** 利用者が明示操作で開くMoodle課題詳細URL。 */
	moodleUrl: string | null;
}

export interface CourseDashboardEntry {
	courseId: number;
	courseName: string;
	fileCount: number;
	violationCount: number;
	nextDueAt: string | null;
}

export interface DashboardSummary {
	courses: CourseDashboardEntry[];
	totalFiles: number;
	totalViolations: number;
	upcomingDeadlineCount: number;
}

export interface CourseRuleOverride {
	courseId: number;
	courseName: string;
	splitBySection: boolean;
	patternTemplate: string | null;
	note: string | null;
}

export interface RuleSet {
	globalPatternTemplate: string;
	courseOverrides: CourseRuleOverride[];
}

export interface UpdateGlobalRuleRequest {
	patternTemplate: string;
}

export interface CourseRuleOverrideInput {
	splitBySection: boolean;
	patternTemplate: string | null;
	note: string | null;
}

export interface UpdateCourseRuleOverrideRequest {
	courseId: number;
	override: CourseRuleOverrideInput;
}

export interface RuleUpdateResult {
	ok: true;
}

export interface NotificationRule {
	id: number;
	offsetMinutes: number;
	label: string;
	enabled: boolean;
}

/** 通知ルール保存時の入力。新規ルールのIDはSQLite側で採番する。 */
export interface NotificationRuleInput {
	id?: number;
	offsetMinutes: number;
	enabled: boolean;
}

export interface NotificationRuleUpdateResult {
	ok: boolean;
	rules: NotificationRule[];
}

export interface DeadlineFilter {
	courseId?: number;
	includePast?: boolean;
	needsReviewOnly?: boolean;
}

export type AssignmentChangeField =
	| "dueAt"
	| "title"
	| "submissionMode"
	| "dueAtStatus"
	| "submitted"
	| "submissionAvailability"
	| "moodleUrl"
	| "removedAt";

/** 同期のたびに検出された課題1件・1フィールド分の変更点。変更点表示に使う */
export interface AssignmentChange {
	assignmentId: number;
	courseName: string;
	title: string;
	field: AssignmentChangeField;
	oldValue: string | null;
	newValue: string | null;
	detectedAt: string; // ISO8601
}

/** 現在の拡張機能実応答APIの通信仕様バージョン。 */
export const EXTENSION_RUNTIME_PROTOCOL_VERSION = 6 as const;
