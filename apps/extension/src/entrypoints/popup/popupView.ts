import type { CachedDashboard } from "../../lib/cache/dashboardCache";

export type PopupDashboardView =
	| {
			state: "cached";
			updatedAt: string;
			totalFiles: number;
			totalViolations: number;
			upcomingDeadlineCount: number;
			courses: Array<{
				name: string;
				fileCount: number;
				violationCount: number;
			}>;
	  }
	| {
			state: "missing";
			message: string;
	  };

export function createPopupDashboardView(cached: CachedDashboard | null): PopupDashboardView {
	if (!cached) {
		return {
			state: "missing",
			message:
				"Moodleを開き、上部の「Fuzzy」から「整理状況」を一度表示すると、ここでも前回の情報を確認できます。",
		};
	}

	return {
		state: "cached",
		updatedAt: formatCachedAt(cached.cachedAt),
		totalFiles: cached.dashboard.totalFiles,
		totalViolations: cached.dashboard.totalViolations,
		upcomingDeadlineCount: cached.dashboard.upcomingDeadlineCount,
		courses: cached.dashboard.courses.map((course) => ({
			name: course.courseName,
			fileCount: course.fileCount,
			violationCount: course.violationCount,
		})),
	};
}

function formatCachedAt(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "更新日時不明";
	return new Intl.DateTimeFormat("ja-JP", {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(date);
}
