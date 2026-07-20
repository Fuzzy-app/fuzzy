// 暫定の型定義。
// 将来的に Rust 側の構造体に `#[derive(TS)]` を付与し、ts-rs で
// `packages/shared/src/generated/` 以下に自動生成する予定（docs/api/contract.md 参照）。
// それまでの間、API契約に合わせてここで手書きしている。生成後はこのファイルを置き換える。

export interface Course {
	id: number;
	moodleCourseId: string;
	name: string;
	term: string | null;
}

export interface SimilarFileMatch {
	fileId: number;
	originalName: string;
	similarity: number;
}

export interface SaveSuggestion {
	path: string;
	confidence: number; // 0.0〜1.0、確からしさ順の表示に使う
	similarMatches?: SimilarFileMatch[];
}

export interface MoodleCourseContext {
	name: string | null;
	sectionTitle: string | null;
	breadcrumbs: string[];
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
}

export interface SaveFilesRequest {
	files: MoodleFileMeta[];
	targetPath: string;
}

export interface SaveFilesResult {
	savedFileIds: string[];
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

export interface SearchResult {
	fileId: number;
	fileName: string;
	courseName: string | null;
	snippet: string;
	page: number | null;
	score: number;
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

export interface RuleViolation {
	fileId: number;
	fileName: string;
	courseName: string | null;
	savedPath: string;
	reason: string;
}

export interface DuplicateGroup {
	groupId: number;
	method: "exact" | "similar";
	members: { fileId: number; fileName: string; similarity: number }[];
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

/** Moodleからの課題・締切データ取得（同期）1回分の結果。データ取得通知に使う */
export interface DataSyncEvent {
	id: number;
	syncedAt: string; // ISO8601
	trigger: "manual" | "auto";
	newAssignmentCount: number;
	changedAssignmentCount: number;
	removedAssignmentCount: number;
}

export type AssignmentChangeField =
	| "dueAt"
	| "title"
	| "submissionMode"
	| "dueAtStatus"
	| "submitted";

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
export const EXTENSION_RUNTIME_PROTOCOL_VERSION = 1 as const;

/** 拡張機能がnative-hostへ報告する、ブラウザ名に依存しない実行情報。 */
export interface ExtensionRuntimeReport {
	installationId: string;
	extensionVersion: string;
	protocolVersion: number;
}

/** SQLiteに保存された、インストール・バージョン単位の初回／最終応答。 */
export interface ExtensionRuntimeObservation extends ExtensionRuntimeReport {
	firstSeenAt: string;
	lastSeenAt: string;
}

export type ExtensionSetupState = "waiting" | "ready" | "incompatible";

/** 初期セットアップ画面がSQLiteから読み取る拡張機能の応答状態。 */
export interface ExtensionSetupStatus {
	state: ExtensionSetupState;
	observation: ExtensionRuntimeObservation | null;
}
