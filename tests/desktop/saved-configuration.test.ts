import { describe, expect, test } from "bun:test";
import {
	configurationToSnapshot,
	createStoredPatternCandidate,
	describeSetupChanges,
	displayBaseFolderName,
	editableRuleSegmentsFromTemplate,
	resolveRuleId,
} from "../../apps/desktop/src/lib/setup/saved-configuration";
import type { SavedSetupConfiguration } from "../../apps/desktop/src/lib/setup/types";
import { ruleSegmentsToTemplate } from "../../packages/shared/src/rules";

function configuration(overrides: Partial<SavedSetupConfiguration> = {}): SavedSetupConfiguration {
	return {
		revision: "setup-v1:test",
		savedAt: "2026-07-29T00:00:00.000Z",
		baseFolderPath: "C:/Users/student/Documents/Fuzzy",
		pattern: { id: "estimated-1", courseSegmentIndex: 1 },
		rule: {
			id: "year-course-assignment",
			template: "{year}/{course}/{assignment}",
		},
		courseOverrides: [{ courseName: "データベース", enabled: true, mode: "override" }],
		...overrides,
	};
}

describe("saved setup configuration", () => {
	test("保存済み設定を内部表現を見せない候補へ変換する", () => {
		const candidate = createStoredPatternCandidate(configuration());

		expect(candidate.name).toBe("年度 / 科目 / 課題");
		expect(candidate.name).not.toContain("{");
		expect(candidate.courseSegmentIndex).toBe(1);
	});

	test("授業回の既存形式を失わず往復する", () => {
		const segments = editableRuleSegmentsFromTemplate("{year}年度/{term}/{course}/第{section}回");

		expect(segments).not.toBeNull();
		expect(ruleSegmentsToTemplate(segments ?? [])).toBe("{year}年度/{term}/{course}/第{section}回");
	});

	test("構造化編集できない保存形式を安全に保留する", () => {
		expect(editableRuleSegmentsFromTemplate("第{year}年度/{course}")).toBeNull();
		expect(
			createStoredPatternCandidate(
				configuration({
					rule: { id: "legacy", template: "第{year}年度/{course}" },
				}),
			).name,
		).toBe("保存済みの構成");
	});

	test("絶対パスではなく選択フォルダー名だけを表示する", () => {
		expect(displayBaseFolderName("C:\\Users\\student\\Documents\\Fuzzy")).toBe("Fuzzy");
		expect(displayBaseFolderName(null)).toBe("まだ選択されていません");
	});

	test("利用者向けの変更点だけを列挙する", () => {
		const original = configurationToSnapshot(configuration());
		const changed = {
			...original,
			ruleTemplate: "{term}/{course}/{assignment}",
			courseNames: ["データベース", "離散数学"],
		};

		expect(describeSetupChanges(original, changed)).toEqual([
			"フォルダーの作り方を変更",
			"授業ごとの扱いを変更",
		]);
		expect(resolveRuleId(original.ruleTemplate, configuration())).toBe("year-course-assignment");
	});
});
