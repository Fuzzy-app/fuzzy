/**
 * ルール管理画面が利用する拡張機能内の型境界。
 * native-host 接続時も画面側はこの形を維持し、API アダプターだけを差し替える。
 */
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
	courseName: string;
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

/** issue #53 の警告表示からも同じスナップショットを参照できる API 境界。 */
export interface RuleManagementApi {
	readonly mode: "local-mock" | "native";

	getRules(): Promise<RuleSet>;

	updateGlobalRule(request: UpdateGlobalRuleRequest): Promise<RuleUpdateResult>;

	updateCourseRuleOverride(request: UpdateCourseRuleOverrideRequest): Promise<RuleUpdateResult>;
}

export type RuleManagementStatus = "idle" | "loading" | "ready" | "error";

export type RuleSaveTarget = { scope: "global" } | { scope: "course"; courseId: number };

/** UI が描画に使う唯一の状態。保存中も直前の rules を保持する。 */
export interface RuleManagementState {
	status: RuleManagementStatus;
	rules: RuleSet | null;
	saving: RuleSaveTarget | null;
	error: string | null;
	lastSavedTarget: RuleSaveTarget | null;
	lastSavedAt: string | null;
}
