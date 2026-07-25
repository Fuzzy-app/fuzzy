import { describe, expect, test } from "bun:test";
import {
	assignmentChangeFieldLabel,
	assignmentChangeValueLabel,
	syncChangeTotal,
} from "../../apps/extension/src/entrypoints/content/shellPresentation";

describe("課題同期の変更件数と削除表示", () => {
	test("削除・復帰を変更件数へ二重計上せず同期状態として表示する", () => {
		expect(
			syncChangeTotal({
				id: 1,
				syncedAt: "2026-07-25T09:00:00Z",
				trigger: "auto",
				newAssignmentCount: 0,
				changedAssignmentCount: 0,
				removedAssignmentCount: 1,
			}),
		).toBe(1);
		expect(
			syncChangeTotal({
				id: 2,
				syncedAt: "2026-07-25T10:00:00Z",
				trigger: "auto",
				newAssignmentCount: 1,
				changedAssignmentCount: 0,
				removedAssignmentCount: 0,
			}),
		).toBe(1);
		expect(assignmentChangeFieldLabel("removedAt")).toBe("同期状態");
		expect(assignmentChangeValueLabel("removedAt", null)).toBe("同期対象");
		expect(assignmentChangeValueLabel("removedAt", "2026-07-25T09:00:00Z")).toContain("同期対象外");
	});
});
