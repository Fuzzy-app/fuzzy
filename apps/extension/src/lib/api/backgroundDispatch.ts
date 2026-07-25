import type {
	CheckSimilarFilesRequest,
	ExtractZipRequest,
	FuzzyApiClient,
	NotificationRuleInput,
	SaveFilesRequest,
	SuggestSavePathRequest,
	UpdateCourseFolderNameRequest,
} from "@fuzzy/shared";
import type { FuzzyApiRequestMessage } from "./backgroundApi";

// リクエスト本文はruntimeメッセージ境界で型情報を失うため、methodごとに共有API型へ戻す。
export async function callBackgroundApi(
	client: FuzzyApiClient,
	message: FuzzyApiRequestMessage,
): Promise<unknown> {
	switch (message.method) {
		case "suggestSavePath":
			return client.suggestSavePath(message.request as SuggestSavePathRequest);
		case "updateCourseFolderName":
			return client.updateCourseFolderName(message.request as UpdateCourseFolderNameRequest);
		case "checkSimilarFiles":
			return client.checkSimilarFiles(message.request as CheckSimilarFilesRequest);
		case "saveFiles":
			return client.saveFiles(message.request as SaveFilesRequest);
		case "extractZip":
			return client.extractZip(message.request as ExtractZipRequest);
		case "getNotificationRules":
			return client.getNotificationRules();
		case "updateNotificationRules":
			return client.updateNotificationRules(message.request as NotificationRuleInput[]);
	}
}
