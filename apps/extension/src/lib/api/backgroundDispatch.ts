import type {
	CheckSimilarFilesRequest,
	DashboardSummary,
	DataSyncEvent,
	DeadlineFilter,
	ExtractZipRequest,
	FuzzyApiClient,
	NotificationRuleInput,
	RebuildLibraryRequest,
	SuggestSavePathRequest,
	SyncMoodleAssignmentsRequest,
	UpdateCourseFolderNameRequest,
} from "@fuzzy/shared";
import type { FuzzyApiRequestMessage } from "./backgroundApi";

export interface BackgroundApiDispatchOptions {
	/** native-host由来の実データだけを拡張機能originへキャッシュする。 */
	writeDashboardCache?: (dashboard: DashboardSummary) => Promise<void>;
	/** 同期コマンドの成功ごとに、返されたeventを取りこぼさず通知する。 */
	notifySyncEvent?: (event: DataSyncEvent) => Promise<void>;
	onSyncNotificationError?: (error: unknown) => void;
}

// リクエスト本文はruntimeメッセージ境界で型情報を失うため、methodごとに共有API型へ戻す。
export async function callBackgroundApi(
	client: FuzzyApiClient,
	message: FuzzyApiRequestMessage,
	options: BackgroundApiDispatchOptions = {},
): Promise<unknown> {
	switch (message.method) {
		case "getDashboard": {
			const dashboard = await client.getDashboard();
			if (client.mode === "native") {
				await options.writeDashboardCache?.(dashboard);
			}
			return dashboard;
		}
		case "getDeadlines":
			return client.getDeadlines(message.request as DeadlineFilter);
		case "updateSubmissionStatus": {
			const request = message.request as { assignmentId: number; submitted: boolean };
			return client.updateSubmissionStatus(request.assignmentId, request.submitted);
		}
		case "search":
			return client.search((message.request as { query: string }).query);
		case "suggestSavePath":
			return client.suggestSavePath(message.request as SuggestSavePathRequest);
		case "updateCourseFolderName":
			return client.updateCourseFolderName(message.request as UpdateCourseFolderNameRequest);
		case "checkSimilarFiles":
			return client.checkSimilarFiles(message.request as CheckSimilarFilesRequest);
		case "saveFiles":
			throw new Error("saveFilesは認証付き取得を行うbackgroundの専用経路で処理してください");
		case "extractZip":
			return client.extractZip(message.request as ExtractZipRequest);
		case "getNotificationRules":
			return client.getNotificationRules();
		case "updateNotificationRules":
			return client.updateNotificationRules(message.request as NotificationRuleInput[]);
		case "syncMoodleAssignments": {
			const event = await client.syncMoodleAssignments(
				message.request as SyncMoodleAssignmentsRequest,
			);
			if (client.mode === "native") {
				try {
					await options.notifySyncEvent?.(event);
				} catch (error) {
					// SQLiteの同期commitは完了済みなので、通知失敗をAPI失敗へ変換しない。
					options.onSyncNotificationError?.(error);
				}
			}
			return event;
		}
		case "getLatestSyncEvent":
			return client.getLatestSyncEvent();
		case "getAssignmentChanges":
			return client.getAssignmentChanges(
				(message.request as { sinceSyncEventId?: number }).sinceSyncEventId,
			);
		case "rebuildLibrary":
			return client.rebuildLibrary(message.request as RebuildLibraryRequest);
	}
}
