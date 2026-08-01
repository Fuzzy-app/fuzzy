export type PresentationStateTone = "loading" | "ready" | "empty" | "success" | "warning" | "error";

export interface PresentationProgress {
	phase: string;
	completed: number;
	total: number;
}

/**
 * 画面ごとの複数のフラグや内部エラーを、利用者が判断できる1つの主状態へまとめる。
 * technicalDetailsは通常表示せず、明示的に開く技術詳細だけで使用する。
 */
export interface PresentationState {
	tone: PresentationStateTone;
	title: string;
	impact?: string;
	actionLabel?: string;
	progress?: PresentationProgress;
	technicalDetails?: string;
}

export function presentationProgressLabel(progress: PresentationProgress): string {
	const total = Math.max(0, Math.trunc(progress.total));
	const completed = Math.min(total, Math.max(0, Math.trunc(progress.completed)));
	return total > 0 ? `${progress.phase}（${completed}/${total}件）` : progress.phase;
}
