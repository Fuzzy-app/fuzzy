import { type RuleSegment, createRuleSegment, validateRuleSegments } from "@fuzzy/shared";
import type { PatternCandidate } from "./types";

/**
 * #114 が返す構造化済みの階層役割へ画面用の安定IDだけを加える。
 * 利用者向けの候補名は表示専用であり、ルールへ逆変換しない。
 */
export function inferredCandidateToRuleSegments(candidate: PatternCandidate): RuleSegment[] | null {
	if (
		candidate.requiresConfirmation ||
		candidate.courseSegmentIndex === null ||
		candidate.directorySegments === null
	) {
		return null;
	}
	const segments = candidate.directorySegments.map((segment, index) => ({
		...createRuleSegment(segment.kind, index, segment.value),
		...(segment.format ? { format: segment.format } : {}),
	}));
	return validateRuleSegments(segments) === null ? segments : null;
}
