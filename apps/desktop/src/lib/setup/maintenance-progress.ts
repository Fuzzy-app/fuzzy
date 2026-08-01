import type { LibraryMaintenanceProgress } from "@fuzzy/shared";

export interface MaintenanceProgressPresentation {
	title: string;
	countLabel: string;
	availabilityLabel: string;
	percent: number | null;
	ariaValueText: string;
}

function phaseTitle(progress: LibraryMaintenanceProgress | null): string {
	if (!progress) return "処理を開始しています";

	switch (progress.phase) {
		case "scanning":
			return "保存先の資料を確認しています";
		case "registering":
			return "資料の情報を登録しています";
		case "indexing":
			return "検索・整理情報を準備しています";
		case "finalizing":
			return "利用開始の準備を仕上げています";
		case "completed":
			if (progress.state === "failed") {
				return "資料情報を準備できませんでした";
			}
			if (progress.state === "completedWithWarnings") {
				return "確認が必要な項目を残して完了しました";
			}
			return "資料情報の準備が完了しました";
	}
}

function progressPercent(progress: LibraryMaintenanceProgress | null): number | null {
	if (!progress) return null;
	if (progress.phase === "completed" && progress.state !== "failed") return 100;
	if (progress.totalCount === null || progress.totalCount <= 0) return null;
	return Math.min(
		100,
		Math.max(0, Math.round((progress.completedCount / progress.totalCount) * 100)),
	);
}

function progressCountLabel(progress: LibraryMaintenanceProgress | null): string {
	if (!progress || progress.totalCount === null) return "件数を確認中";
	return `${progress.completedCount.toLocaleString()} / ${progress.totalCount.toLocaleString()}件`;
}

export function presentMaintenanceProgress(
	progress: LibraryMaintenanceProgress | null,
): MaintenanceProgressPresentation {
	const title = phaseTitle(progress);
	const countLabel = progressCountLabel(progress);
	const warningLabel =
		progress && progress.warningCount > 0
			? `、確認が必要な項目${progress.warningCount.toLocaleString()}件`
			: "";
	const availabilityLabel =
		progress?.phase === "completed" && progress.state === "failed"
			? "同じ操作をもう一度実行できます。"
			: progress?.phase === "completed"
				? "処理は完了しました。"
				: "この処理は途中で中止できません。完了までお待ちください。";

	return {
		title,
		countLabel,
		availabilityLabel,
		percent: progressPercent(progress),
		ariaValueText: `${title}、${countLabel}${warningLabel}`,
	};
}
