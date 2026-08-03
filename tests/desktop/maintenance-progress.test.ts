import { describe, expect, test } from "bun:test";
import { presentMaintenanceProgress } from "../../apps/desktop/src/lib/setup/maintenance-progress";

describe("desktopの資料情報進捗", () => {
	test("処理フェーズを利用者向けの言葉と件数へ変換する", () => {
		expect(
			presentMaintenanceProgress({
				phase: "indexing",
				state: "running",
				completedCount: 1200,
				totalCount: 4000,
				warningCount: 2,
			}),
		).toEqual({
			title: "検索・整理情報を準備しています",
			countLabel: "1,200 / 4,000件",
			availabilityLabel: "この処理は途中で中止できません。完了までお待ちください。",
			percent: 30,
			ariaValueText: "検索・整理情報を準備しています、1,200 / 4,000件",
		});
	});

	test("合計0件の正常完了を100%として伝える", () => {
		const presentation = presentMaintenanceProgress({
			phase: "completed",
			state: "completed",
			completedCount: 0,
			totalCount: 0,
			warningCount: 0,
		});

		expect(presentation.percent).toBe(100);
		expect(presentation.title).toBe("完了しました");
		expect(presentation.availabilityLabel).toBe("完了しました。");
	});

	test("失敗後に再試行できることを示す", () => {
		const presentation = presentMaintenanceProgress({
			phase: "completed",
			state: "failed",
			completedCount: 0,
			totalCount: null,
			warningCount: 0,
		});

		expect(presentation.percent).toBeNull();
		expect(presentation.title).toBe("資料情報を準備できませんでした");
		expect(presentation.availabilityLabel).toBe("同じ操作をもう一度実行できます。");
	});
});
