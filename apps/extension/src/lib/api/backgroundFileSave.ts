import type {
	CheckSimilarFilesRequest,
	FuzzyApiClient,
	MoodleSaveFilesRequest,
	SaveFilePayload,
	SaveFilesResult,
	SimilarFileMatch,
} from "@fuzzy/shared";
import { FILE_TRANSFER_LIMITS } from "@fuzzy/shared";
import {
	type MoodleFileDownloadOptions,
	downloadMoodleFile,
	downloadMoodleFiles,
	transferFileId,
} from "../moodle/fileDownloader";

const MAX_CONCURRENT_SIMILARITY_CHECKS = 2;
let activeSimilarityChecks = 0;
const similarityCheckWaiters: Array<() => void> = [];
const SIMILARITY_DOWNLOAD_CACHE_TTL_MS = 2 * 60_000;
const MAX_SIMILARITY_DOWNLOAD_CACHE_ENTRIES = FILE_TRANSFER_LIMITS.maxFiles;
const MAX_SIMILARITY_DOWNLOAD_CACHE_BYTES = FILE_TRANSFER_LIMITS.maxTransferBytes;
const similarityDownloadCache = new Map<string, { payload: SaveFilePayload; expiresAt: number }>();
let similarityDownloadCacheBytes = 0;

export async function checkMoodleFileFromBackground(
	client: Pick<FuzzyApiClient, "mode" | "checkSimilarFiles">,
	request: CheckSimilarFilesRequest,
	pageOrigin: string,
	downloadOptions: MoodleFileDownloadOptions = {},
): Promise<SimilarFileMatch[]> {
	if (client.mode === "mock") return client.checkSimilarFiles(request);
	return withSimilarityCheckSlot(async () => {
		const downloaded = await downloadMoodleFile(request.fileMeta, pageOrigin, downloadOptions);
		if (!downloaded) throw new Error("Moodle資料を類似照合用に取得できません");
		rememberSimilarityDownload(request.fileMeta, pageOrigin, downloaded);
		return client.checkSimilarFiles({
			fileMeta: request.fileMeta,
			courseId: request.courseId ?? null,
			contentBase64: downloaded.contentBase64,
		});
	});
}

async function withSimilarityCheckSlot<T>(operation: () => Promise<T>): Promise<T> {
	await acquireSimilarityCheckSlot();
	try {
		return await operation();
	} finally {
		releaseSimilarityCheckSlot();
	}
}

function acquireSimilarityCheckSlot(): Promise<void> {
	if (activeSimilarityChecks < MAX_CONCURRENT_SIMILARITY_CHECKS) {
		activeSimilarityChecks += 1;
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		similarityCheckWaiters.push(resolve);
	});
}

function releaseSimilarityCheckSlot(): void {
	const next = similarityCheckWaiters.shift();
	if (next) {
		next();
		return;
	}
	activeSimilarityChecks -= 1;
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
			conflictPolicy: request.conflictPolicy,
			files: request.files.map(mockPayload),
		});
	}

	const prepared = await downloadMoodleFiles(request, pageOrigin, {
		...downloadOptions,
		reusePreparedFile: (file) =>
			takeSimilarityDownload(file, pageOrigin) ?? downloadOptions.reusePreparedFile?.(file) ?? null,
	});
	const saved =
		prepared.request.files.length > 0
			? await client.saveFiles(prepared.request)
			: { savedFileIds: [], failedFiles: [] };
	return {
		savedFileIds: saved.savedFileIds,
		failedFiles: [...prepared.failedFiles, ...saved.failedFiles],
	};
}

function similarityDownloadKey(
	file: CheckSimilarFilesRequest["fileMeta"],
	pageOrigin: string,
): string {
	return `${pageOrigin}\n${file.url}\n${file.moodleFileId ?? ""}\n${file.title}`;
}

function rememberSimilarityDownload(
	file: CheckSimilarFilesRequest["fileMeta"],
	pageOrigin: string,
	payload: SaveFilePayload,
): void {
	const now = Date.now();
	for (const [key, cached] of similarityDownloadCache) {
		if (cached.expiresAt <= now) removeSimilarityDownload(key);
	}
	const key = similarityDownloadKey(file, pageOrigin);
	removeSimilarityDownload(key);
	if (payload.byteLength > MAX_SIMILARITY_DOWNLOAD_CACHE_BYTES) return;
	while (
		similarityDownloadCache.size >= MAX_SIMILARITY_DOWNLOAD_CACHE_ENTRIES ||
		similarityDownloadCacheBytes + payload.byteLength > MAX_SIMILARITY_DOWNLOAD_CACHE_BYTES
	) {
		const oldest = similarityDownloadCache.keys().next().value;
		if (typeof oldest !== "string") break;
		removeSimilarityDownload(oldest);
	}
	similarityDownloadCache.set(key, {
		payload,
		expiresAt: now + SIMILARITY_DOWNLOAD_CACHE_TTL_MS,
	});
	similarityDownloadCacheBytes += payload.byteLength;
}

function takeSimilarityDownload(
	file: CheckSimilarFilesRequest["fileMeta"],
	pageOrigin: string,
): SaveFilePayload | null {
	const key = similarityDownloadKey(file, pageOrigin);
	const cached = removeSimilarityDownload(key);
	return cached && cached.expiresAt > Date.now() ? cached.payload : null;
}

function removeSimilarityDownload(
	key: string,
): { payload: SaveFilePayload; expiresAt: number } | undefined {
	const cached = similarityDownloadCache.get(key);
	if (!cached) return undefined;
	similarityDownloadCache.delete(key);
	similarityDownloadCacheBytes = Math.max(
		0,
		similarityDownloadCacheBytes - cached.payload.byteLength,
	);
	return cached;
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
