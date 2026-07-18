import type {
	FuzzyApiClient,
	RuleSet,
	UpdateCourseRuleOverrideRequest,
	UpdateGlobalRuleRequest,
} from "@fuzzy/shared";

/** issue #53 の警告表示からも同じスナップショットを参照できる共有API境界。 */
export type RuleManagementApi = Pick<
	FuzzyApiClient,
	"mode" | "getRules" | "updateGlobalRule" | "updateCourseRuleOverride"
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
}

export type { RuleSet, UpdateCourseRuleOverrideRequest, UpdateGlobalRuleRequest };
