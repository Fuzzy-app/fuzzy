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

export interface SaveSuggestion {
	path: string;
	confidence: number; // 0.0〜1.0、確からしさ順の表示に使う
	similarMatches?: { fileId: number; originalName: string; similarity: number }[];
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

export interface DeadlineFilter {
	courseId?: number;
	includePast?: boolean;
	needsReviewOnly?: boolean;
}
