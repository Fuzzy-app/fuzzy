import { describe, expect, test } from "bun:test";
import { createPopupDashboardView } from "../../apps/extension/src/entrypoints/popup/popupView";
import { parseCachedDashboard } from "../../apps/extension/src/lib/cache/dashboardCache";

describe("popupのオフラインダッシュボード", () => {
	test("旧mock形式や出所不明のキャッシュを拒否する", () => {
		const dashboard = {
			courses: [],
			totalFiles: 0,
			totalViolations: 0,
			upcomingDeadlineCount: 0,
		};

		expect(parseCachedDashboard({ dashboard, cachedAt: new Date().toISOString() })).toBeNull();
		expect(
			parseCachedDashboard({
				formatVersion: 2,
				source: "mock",
				dashboard,
				cachedAt: new Date().toISOString(),
			}),
		).toBeNull();
	});

	test("キャッシュがない場合は空データではなく再取得条件を示す", () => {
		const view = createPopupDashboardView(null);
		expect(view.state).toBe("missing");
		if (view.state === "missing") {
			expect(view.message).toContain("キャッシュがありません");
			expect(view.message).toContain("Moodle");
		}
	});

	test("キャッシュの集計とコース一覧を表示用モデルへ変換する", () => {
		const view = createPopupDashboardView({
			formatVersion: 2,
			source: "native",
			cachedAt: "2026-07-25T03:00:00.000Z",
			dashboard: {
				totalFiles: 9,
				totalViolations: 2,
				upcomingDeadlineCount: 3,
				courses: [
					{
						courseId: 2,
						courseName: "データベース",
						fileCount: 4,
						violationCount: 1,
						nextDueAt: null,
					},
				],
			},
		});
		expect(view).toMatchObject({
			state: "cached",
			totalFiles: 9,
			totalViolations: 2,
			upcomingDeadlineCount: 3,
			courses: [{ name: "データベース", fileCount: 4, violationCount: 1 }],
		});
	});
});
