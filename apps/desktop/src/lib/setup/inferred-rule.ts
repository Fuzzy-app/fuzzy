import {
	type RuleSegment,
	type RuleSegmentKind,
	createRuleSegment,
	validateRuleSegments,
} from "@fuzzy/shared";
import type { PatternCandidate } from "./types";

const inferredRoleKinds: Readonly<Record<string, RuleSegmentKind>> = {
	年度: "year",
	学期: "term",
	科目: "course",
	課題: "assignment",
	回次: "section",
	授業回: "section",
};

/**
 * #114 が返す日本語の階層役割を、利用者が編集できる共通モデルへ変換する。
 * ファイル名規則の説明はフォルダー階層ではないため変換対象に含めない。
 */
export function inferredCandidateToRuleSegments(candidate: PatternCandidate): RuleSegment[] | null {
	if (candidate.requiresConfirmation || candidate.courseSegmentIndex === null) return null;
	const folderRoles = candidate.name.split(" + ", 1)[0]?.split(" / ") ?? [];
	const segments = folderRoles.map((role, index) => {
		const normalized = role.trim();
		const kind = inferredRoleKinds[normalized];
		return kind ? createRuleSegment(kind, index) : createRuleSegment("fixed", index, normalized);
	});
	return validateRuleSegments(segments) === null ? segments : null;
}
