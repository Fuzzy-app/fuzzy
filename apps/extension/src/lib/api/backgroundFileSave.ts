import type {
	CheckSimilarFilesRequest,
	FuzzyApiClient,
	MoodleSaveFilesRequest,
	SaveFilePayload,
	SaveFilesResult,
	SimilarFileMatch,
} from "@fuzzy/shared";
import {
	type MoodleFileDownloadOptions,
	downloadMoodleFile,
	downloadMoodleFiles,
	transferFileId,
} from "../moodle/fileDownloader";

export async function checkMoodleFileFromBackground(
	client: Pick<FuzzyApiClient, "mode" | "checkSimilarFiles">,
	request: CheckSimilarFilesRequest,
	pageOrigin: string,
	downloadOptions: MoodleFileDownloadOptions = {},
): Promise<SimilarFileMatch[]> {
	if (client.mode === "mock") return client.checkSimilarFiles(request);
	const downloaded = await downloadMoodleFile(request.fileMeta, pageOrigin, downloadOptions);
	if (!downloaded) throw new Error("Moodle資料を類似照合用に取得できません");
	return client.checkSimilarFiles({
		fileMeta: request.fileMeta,
		contentBase64: downloaded.contentBase64,
	});
}

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
			courseId: request.courseId,
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
