import { describe, expect, test } from "bun:test";
import { inferredCandidateToRuleSegments } from "../../apps/desktop/src/lib/setup/inferred-rule";
import type { PatternCandidate } from "../../apps/desktop/src/lib/setup/types";

function candidate(overrides: Partial<PatternCandidate> = {}): PatternCandidate {
	return {
		id: "estimated-1",
		name: "年度 / 学期 / 科目 / 回次 + 回次付きファイル名",
		description: "推定結果",
		folders: ["2026/前期/情報アーキテクチャ/第3回"],
		directorySegments: [
			{ kind: "year" },
			{ kind: "term" },
			{ kind: "course" },
			{ kind: "section", format: "numbered" },
		],
		courseSegmentIndex: 2,
		fileNameTemplate: "{section}_{filename}",
		matchScore: 90,
		evaluatedCount: 1,
		reason: "一致",
		recommended: true,
		requiresConfirmation: false,
		...overrides,
	};
}

describe("#114推定結果の構造化ルール変換", () => {
	test("階層役割だけを編集モデルへ変換し、ファイル名規則を混ぜない", () => {
		const segments = inferredCandidateToRuleSegments(
			candidate({ name: "表示文言が変わっても解析しない候補" }),
		);

		expect(segments?.map(({ kind }) => kind)).toEqual(["year", "term", "course", "section"]);
		expect(segments?.[3]?.format).toBe("numbered");
	});

	test("要確認または科目位置なしの候補を自動適用しない", () => {
		expect(inferredCandidateToRuleSegments(candidate({ requiresConfirmation: true }))).toBeNull();
		expect(inferredCandidateToRuleSegments(candidate({ courseSegmentIndex: null }))).toBeNull();
		expect(inferredCandidateToRuleSegments(candidate({ directorySegments: null }))).toBeNull();
	});
});
