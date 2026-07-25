import type {
	MoodleFileMeta,
	MoodleSaveFilesRequest,
	SaveFileFailure,
	SaveFilePayload,
	SaveFilesRequest,
} from "@fuzzy/shared";
import { FILE_TRANSFER_LIMITS } from "@fuzzy/shared";
import {
	fileExtensionFromName,
	fileNameFromContentDisposition,
	normalizeFileTypeHint,
} from "./fileType";

const DOWNLOAD_CONCURRENCY = 2;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429]);

export interface MoodleFileDownloadOptions {
	fetcher?: typeof fetch;
	timeoutMs?: number;
	maxFileBytes?: number;
	maxTransferBytes?: number;
	concurrency?: number;
}

export interface PreparedSaveFiles {
	request: SaveFilesRequest;
	failedFiles: SaveFileFailure[];
}

/**
 * ログイン済み拡張機能から同一オリジンの資料本体を取得する。
 * Cookie自体は返さず、取得済み内容だけをnative-host向けpayloadにする。
 */
export async function downloadMoodleFiles(
	request: MoodleSaveFilesRequest,
	pageOrigin: string,
	options: MoodleFileDownloadOptions = {},
): Promise<PreparedSaveFiles> {
	const files = request.files.slice(0, FILE_TRANSFER_LIMITS.maxFiles);
	const prepared: Array<SaveFilePayload | null> = Array.from({ length: files.length }, () => null);
	const failedFiles: SaveFileFailure[] = [];
	const fetcher = options.fetcher ?? fetch;
	const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
	const maxFileBytes = options.maxFileBytes ?? FILE_TRANSFER_LIMITS.maxFileBytes;
	const budget = {
		used: 0,
		maximum: options.maxTransferBytes ?? FILE_TRANSFER_LIMITS.maxTransferBytes,
	};
	let nextIndex = 0;

	async function runWorker(): Promise<void> {
		while (nextIndex < files.length) {
			const index = nextIndex++;
			const file = files[index];
			if (!file) return;
			const fileId = transferFileId(file);
			const downloaded = await downloadFile(
				file,
				pageOrigin,
				fetcher,
				timeoutMs,
				maxFileBytes,
				budget,
			);
			if (downloaded) prepared[index] = downloaded;
			else failedFiles.push({ fileId, code: "DOWNLOAD_FAILED" });
		}
	}

	const concurrency = Math.max(
		1,
		Math.min(options.concurrency ?? DOWNLOAD_CONCURRENCY, files.length || 1),
	);
	await Promise.all(Array.from({ length: concurrency }, () => runWorker()));

	for (const ignored of request.files.slice(FILE_TRANSFER_LIMITS.maxFiles)) {
		failedFiles.push({ fileId: transferFileId(ignored), code: "DOWNLOAD_FAILED" });
	}
	return {
		request: {
			targetPath: request.targetPath,
			courseId: request.courseId,
			files: prepared.filter((file): file is SaveFilePayload => file !== null),
		},
		failedFiles,
	};
}

export async function downloadMoodleFile(
	file: MoodleFileMeta,
	pageOrigin: string,
	options: MoodleFileDownloadOptions = {},
): Promise<SaveFilePayload | null> {
	const maxFileBytes = options.maxFileBytes ?? FILE_TRANSFER_LIMITS.maxFileBytes;
	return downloadFile(
		file,
		pageOrigin,
		options.fetcher ?? fetch,
		options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
		maxFileBytes,
		{ used: 0, maximum: maxFileBytes },
	);
}

export function transferFileId(file: MoodleFileMeta): string {
	return file.moodleFileId ?? file.url;
}

async function downloadFile(
	file: MoodleFileMeta,
	pageOrigin: string,
	fetcher: typeof fetch,
	timeoutMs: number,
	maxFileBytes: number,
	budget: { used: number; maximum: number },
): Promise<SaveFilePayload | null> {
	if (!isSameOrigin(file.url, pageOrigin)) return null;

	for (let attempt = 0; attempt < 2; attempt += 1) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		let reservedBytes = 0;
		let keepReservation = false;
		try {
			const response = await fetcher(file.url, {
				method: "GET",
				credentials: "include",
				redirect: "follow",
				signal: controller.signal,
			});
			if (!response.ok) {
				if (attempt === 0 && isRetryableStatus(response.status)) continue;
				return null;
			}
			const finalUrl = response.url || file.url;
			if (!isSameOrigin(finalUrl, pageOrigin)) return null;

			const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
			if (Number.isFinite(declaredLength) && declaredLength > maxFileBytes) return null;
			const bytes = await readLimitedBody(response, maxFileBytes, (length) => {
				if (budget.used + length > budget.maximum) return false;
				budget.used += length;
				reservedBytes += length;
				return true;
			});
			if (!bytes) return null;

			const contentType = response.headers.get("content-type");
			const dispositionName = fileNameFromContentDisposition(
				response.headers.get("content-disposition"),
			);
			const mimeHint =
				normalizeFileTypeHint(contentType) ??
				fileExtensionFromName(dispositionName ?? "") ??
				normalizeFileTypeHint(file.mimeHint) ??
				fileExtensionFromName(file.title);
			if (!mimeHint || mimeHint === "html" || looksLikeHtml(bytes)) return null;
			if (mimeHint === "docx" && !hasZipSignature(bytes)) return null;
			keepReservation = true;

			return {
				fileId: transferFileId(file),
				fileName: resolvedFileName(file.title, dispositionName, mimeHint),
				mimeType: contentType?.split(";", 1)[0]?.trim() || null,
				byteLength: bytes.byteLength,
				contentBase64: bytesToBase64(bytes),
			};
		} catch {
			if (attempt === 1) return null;
		} finally {
			if (!keepReservation) budget.used -= reservedBytes;
			clearTimeout(timeout);
		}
	}
	return null;
}

async function readLimitedBody(
	response: Response,
	maxBytes: number,
	reserve: (length: number) => boolean,
): Promise<Uint8Array | null> {
	const reader = response.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;
			if (length + value.byteLength > maxBytes || !reserve(value.byteLength)) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
			length += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	if (length === 0) return null;
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function resolvedFileName(title: string, dispositionName: string | null, mimeHint: string): string {
	const name = dispositionName ?? (title.trim() || "資料");
	return fileExtensionFromName(name) ? name : `${name}.${mimeHint}`;
}

function isRetryableStatus(status: number): boolean {
	return RETRYABLE_HTTP_STATUS.has(status) || status >= 500;
}

function isSameOrigin(url: string, origin: string): boolean {
	try {
		return Boolean(origin) && new URL(url).origin === new URL(origin).origin;
	} catch {
		return false;
	}
}

function looksLikeHtml(bytes: Uint8Array): boolean {
	const prefix = new TextDecoder().decode(bytes.slice(0, 512)).trimStart().toLowerCase();
	return prefix.startsWith("<!doctype html") || prefix.startsWith("<html");
}

function hasZipSignature(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 4 &&
		bytes[0] === 0x50 &&
		bytes[1] === 0x4b &&
		((bytes[2] === 0x03 && bytes[3] === 0x04) ||
			(bytes[2] === 0x05 && bytes[3] === 0x06) ||
			(bytes[2] === 0x07 && bytes[3] === 0x08))
	);
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}
	return btoa(binary);
}
