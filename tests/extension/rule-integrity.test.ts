import { describe, expect, test } from "bun:test";
import type { DuplicateGroup, RuleViolation } from "@fuzzy/shared";
import {
	duplicateMethodLabel,
	summarizeRuleIntegrity,
} from "../../apps/extension/src/lib/integrity/ruleIntegrity";

describe("ルール違反・重複候補の集計", () => {
	test("警告件数、影響する授業、重複ファイルを重複なしで数える", () => {
		const violations: RuleViolation[] = [
			{ fileId: 1, fileName: "a.pdf", courseName: "データベース", savedPath: "a", reason: "x" },
			{ fileId: 2, fileName: "b.pdf", courseName: "データベース", savedPath: "b", reason: "y" },
			{ fileId: 3, fileName: "c.pdf", courseName: null, savedPath: "c", reason: "z" },
		];
		const duplicateGroups: DuplicateGroup[] = [
			{
				groupId: 1,
				method: "exact",
				members: [
					{ fileId: 1, fileName: "a.pdf", similarity: 1 },
					{ fileId: 2, fileName: "b.pdf", similarity: 1 },
				],
			},
			{
				groupId: 2,
				method: "similar",
				members: [
					{ fileId: 2, fileName: "b.pdf", similarity: 0.92 },
					{ fileId: 4, fileName: "d.pdf", similarity: 0.9 },
				],
			},
		];

		expect(summarizeRuleIntegrity(violations, duplicateGroups)).toEqual({
			violationCount: 3,
			affectedCourseCount: 1,
			duplicateGroupCount: 2,
			duplicateFileCount: 3,
		});
	});

	test("重複判定方法を利用者向けの表示へ変換する", () => {
		expect(duplicateMethodLabel("exact")).toBe("完全一致");
		expect(duplicateMethodLabel("similar")).toBe("類似");
	});
});
