import type {
	FuzzyApiClient,
	LibraryMaintenanceSummary,
	ReconcileCourseFilesRequest,
} from "@fuzzy/shared";

const DEFAULT_DEBOUNCE_MS = 5 * 60_000;

interface CompletedCourseReconcile {
	completedAt: number;
	summary: LibraryMaintenanceSummary;
}

/**
 * 同一コースのタブ再読込・複数タブからの要求を1本へまとめる。
 * 実行中は同じPromiseを共有し、成功後は短時間だけ結果を再利用する。
 */
export function createCourseFileReconcileCoordinator(
	debounceMs = DEFAULT_DEBOUNCE_MS,
	now: () => number = Date.now,
) {
	const inFlight = new Map<string, Promise<LibraryMaintenanceSummary>>();
	const completed = new Map<string, CompletedCourseReconcile>();

	return {
		reconcile(
			client: Pick<FuzzyApiClient, "reconcileCourseFiles">,
			request: ReconcileCourseFilesRequest,
		): Promise<LibraryMaintenanceSummary> {
			const key = request.course.moodleCourseId;
			const running = inFlight.get(key);
			if (running) return running;
			const previous = completed.get(key);
			if (previous && now() - previous.completedAt < debounceMs) {
				return Promise.resolve(previous.summary);
			}

			const operation = client
				.reconcileCourseFiles(request)
				.then((summary) => {
					completed.set(key, { completedAt: now(), summary });
					return summary;
				})
				.finally(() => {
					if (inFlight.get(key) === operation) inFlight.delete(key);
				});
			inFlight.set(key, operation);
			return operation;
		},
	};
}
