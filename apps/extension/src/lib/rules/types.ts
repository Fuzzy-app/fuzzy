import type {
	FuzzyApiClient,
	RuleSet,
	UpdateCourseRuleOverrideRequest,
	UpdateGlobalRuleRequest,
} from "@fuzzy/shared";

/** ルール編集と警告表示が同じbackground接続を利用するための共有API境界。 */
export type RuleManagementApi = Pick<
	FuzzyApiClient,
	| "mode"
	| "getRules"
	| "updateGlobalRule"
	| "updateCourseRuleOverride"
	| "getRuleViolations"
	| "getDuplicateGroups"
>;

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
	/** 更新APIが成功するたびに増える。後続の警告一覧を確実に無効化するために使う。 */
	mutationRevision: number;
}

export type { RuleSet, UpdateCourseRuleOverrideRequest, UpdateGlobalRuleRequest };
