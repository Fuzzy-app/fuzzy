import type {
	FuzzyApiClient,
	MoodleSaveFilesRequest,
	SaveFilePayload,
	SaveFilesResult,
} from "@fuzzy/shared";
import {
	type MoodleFileDownloadOptions,
	downloadMoodleFiles,
	transferFileId,
} from "../moodle/fileDownloader";

/**
 * content scriptから届いたURLをbackgroundで取得済みpayloadへ変換し、
 * Cookie等の認証情報を含めずnative-hostへ渡す。
 */
export async function saveMoodleFilesFromBackground(
	client: Pick<FuzzyApiClient, "mode" | "saveFiles">,
	request: MoodleSaveFilesRequest,
	pageOrigin: string,
	downloadOptions: MoodleFileDownloadOptions = {},
): Promise<SaveFilesResult> {
	if (client.mode === "mock") {
		return client.saveFiles({
			targetPath: request.targetPath,
			files: request.files.map(mockPayload),
		});
	}

	const prepared = await downloadMoodleFiles(request, pageOrigin, downloadOptions);
	const saved =
		prepared.request.files.length > 0
			? await client.saveFiles(prepared.request)
			: { savedFileIds: [], failedFiles: [] };
	return {
		savedFileIds: saved.savedFileIds,
		failedFiles: [...prepared.failedFiles, ...saved.failedFiles],
	};
}

function mockPayload(file: MoodleSaveFilesRequest["files"][number]): SaveFilePayload {
	return {
		fileId: transferFileId(file),
		fileName: file.title,
		mimeType: file.mimeHint,
		byteLength: 0,
		contentBase64: "",
	};
}
