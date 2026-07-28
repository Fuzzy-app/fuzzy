import { FILE_TRANSFER_LIMITS } from "../protocolLimits";
import { EXTENSION_RUNTIME_PROTOCOL_VERSION } from "../types";
import type {
	Assignment,
	AssignmentChange,
	CheckSimilarFilesRequest,
	DashboardSummary,
	DataSyncEvent,
	DeadlineFilter,
	DuplicateGroupListItem,
	ExportDataRequest,
	ExportDataResult,
	ExtensionRuntimeObservation,
	ExtensionRuntimeReport,
	ExtractZipRequest,
	ExtractZipResult,
	ImportDataRequest,
	ImportDataResult,
	LibraryMaintenanceSummary,
	NotificationRule,
	NotificationRuleInput,
	NotificationRuleUpdateResult,
	PingResult,
	RebuildLibraryRequest,
	ReconcileCourseFilesRequest,
	RuleSet,
	RuleUpdateResult,
	RuleViolationListItem,
	SaveFilesRequest,
	SaveFilesResult,
	SaveSuggestion,
	SearchResult,
	SimilarFileMatch,
	SuggestSavePathRequest,
	SyncMoodleAssignmentsRequest,
	UpdateCourseFolderNameRequest,
	UpdateCourseFolderNameResult,
	UpdateCourseRuleOverrideRequest,
	UpdateGlobalRuleRequest,
} from "../types";
import type { FuzzyApiClient } from "./client";
import { ApiError } from "./client";

const NATIVE_HOST_NAME = "jp.ac.wakayama_u.fuzzy.native_host";
/** Firefox/Chrome双方のNative Messaging上限を十分下回るbase64チャンク長。 */
const NATIVE_FILE_CHUNK_CHARACTERS = FILE_TRANSFER_LIMITS.base64ChunkCharacters;
/** 全ファイルの走査・本文抽出・重複再計算を待つ上限。 */
const DEFAULT_LIBRARY_MAINTENANCE_TIMEOUT_MS = 30 * 60_000;
/** 最大256MiBのZIPを検証・展開・安全確定する処理を待つ上限。 */
const DEFAULT_ZIP_EXTRACTION_TIMEOUT_MS = 10 * 60_000;

type Envelope<T> =
	| { id: string; ok: true; data: T }
	| {
			id: string;
			ok: false;
			error: { code: string; message: string };
	  };

type ChunkEnvelope = {
	id: string;
	ok: true;
	chunk: {
		index: number;
		total: number;
		encoding: "base64";
		data: string;
	};
};

type ChunkState = {
	total: number;
	chunks: Array<Uint8Array | undefined>;
	received: number;
	byteLength: number;
};

const MAX_RESPONSE_CHUNKS = 128;
const MAX_REASSEMBLED_RESPONSE_BYTES = 64 * 1024 * 1024;

interface NativePort {
	onMessage: {
		addListener(listener: (message: unknown) => void): void;
		removeListener?(listener: (message: unknown) => void): void;
	};
	onDisconnect?: {
		addListener(listener: () => void): void;
	};
	postMessage(message: unknown): void;
	disconnect(): void;
}

interface NativeRuntime {
	connectNative?: (name: string) => NativePort;
}

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: ApiError): void;
	timeout: ReturnType<typeof setTimeout>;
	chunkState?: ChunkState;
}

export interface NativeApiClientOptions {
	/** 通常コマンドの応答待ち上限。テスト以外は既定値を使用する。 */
	requestTimeoutMs?: number;
	/** ライブラリ全体の再構築だけに使う長時間処理の応答待ち上限。 */
	libraryMaintenanceTimeoutMs?: number;
	/** ZIP展開だけに使う長時間処理の応答待ち上限。 */
	zipExtractionTimeoutMs?: number;
}

/**
 * Native Messaging 経由で native-host（Rustエンジン）と通信する本番実装。
 * docs/api/contract.md の envelope 形式に従う。
 * 拡張機能（chrome.runtime）が存在しない環境（Node等）では ping() が常に false を返し、
 * createApiClient() がNO_NATIVE_HOSTを返せるようにする。
 */
export class NativeApiClient implements FuzzyApiClient {
	readonly mode = "native" as const;
	readonly #requestTimeoutMs: number;
	readonly #libraryMaintenanceTimeoutMs: number;
	readonly #zipExtractionTimeoutMs: number;
	#port: NativePort | null = null;
	readonly #pending = new Map<string, PendingRequest>();

	constructor(options: NativeApiClientOptions = {}) {
		this.#requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
		this.#libraryMaintenanceTimeoutMs =
			options.libraryMaintenanceTimeoutMs ?? DEFAULT_LIBRARY_MAINTENANCE_TIMEOUT_MS;
		this.#zipExtractionTimeoutMs =
			options.zipExtractionTimeoutMs ?? DEFAULT_ZIP_EXTRACTION_TIMEOUT_MS;
	}

	private getChromeRuntime(): NativeRuntime | undefined {
		// biome-ignore lint/suspicious/noExplicitAny: 拡張機能環境以外ではchromeが存在しないため
		return (globalThis as any).chrome?.runtime;
	}

	private send<T>(command: string, payload: unknown): Promise<T> {
		const id = crypto.randomUUID();
		return new Promise<T>((resolve, reject) => {
			let port: NativePort;
			try {
				port = this.#ensurePort();
			} catch (error) {
				reject(toNativeConnectionError(error));
				return;
			}
			const timeout = setTimeout(() => {
				this.#failPort(
					port,
					new ApiError("TIMEOUT", `native-hostからの応答がありません: ${command}`),
				);
			}, this.#requestTimeoutMs);
			this.#pending.set(id, {
				resolve: (value) => resolve(value as T),
				reject,
				timeout,
			});
			try {
				port.postMessage({ id, command, payload });
			} catch (error) {
				this.#failPort(port, toNativeConnectionError(error));
			}
		});
	}

	#ensurePort(): NativePort {
		if (this.#port) return this.#port;
		const runtime = this.getChromeRuntime();
		if (!runtime?.connectNative) {
			throw new ApiError("NO_NATIVE_HOST", "拡張機能環境ではないため native-host に接続できません");
		}

		const port = runtime.connectNative(NATIVE_HOST_NAME);
		this.#port = port;
		port.onMessage.addListener((message) => this.#handleMessage(message));
		port.onDisconnect?.addListener(() => {
			this.#failPort(port, new ApiError("NO_NATIVE_HOST", "native-hostとの接続が切れました"));
		});
		return port;
	}

	#handleMessage(message: unknown): void {
		if (!isEnvelope(message) && !isChunkEnvelope(message)) return;
		const messageId = message.id;
		const pending = this.#pending.get(messageId);
		if (!pending) return;

		let resolvedMessage: unknown = message;
		if (isChunkEnvelope(message)) {
			try {
				const completed = consumeChunk(message, pending.chunkState);
				pending.chunkState = completed.state;
				if (!completed.envelope) return;
				resolvedMessage = completed.envelope;
			} catch {
				clearTimeout(pending.timeout);
				this.#pending.delete(messageId);
				pending.reject(new ApiError("INVALID_RESPONSE", "native-hostの分割応答が不正です"));
				return;
			}
		} else if (pending.chunkState) {
			clearTimeout(pending.timeout);
			this.#pending.delete(messageId);
			pending.reject(new ApiError("INVALID_RESPONSE", "native-hostの分割応答が不正です"));
			return;
		}
		if (!isEnvelope(resolvedMessage)) return;
		clearTimeout(pending.timeout);
		this.#pending.delete(messageId);
		if (resolvedMessage.ok) pending.resolve(resolvedMessage.data);
		else pending.reject(new ApiError(resolvedMessage.error.code, resolvedMessage.error.message));
	}

	#failPort(port: NativePort, error: ApiError): void {
		if (this.#port !== port) return;
		this.#port = null;
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.#pending.clear();
		try {
			port.disconnect();
		} catch {
			// 既にブラウザ側で切断済みなら追加処理は不要。
		}
	}

	/** Moodleタブがなくなったときにbackgroundから明示的にホストを終了する。 */
	disconnect(): void {
		const port = this.#port;
		if (!port) return;
		this.#failPort(port, new ApiError("NO_NATIVE_HOST", "native-hostとの接続を終了しました"));
	}

	private openSession(): {
		send<T>(command: string, payload: unknown, timeoutMs?: number): Promise<T>;
		disconnect(): void;
	} {
		const runtime = this.getChromeRuntime();
		if (!runtime?.connectNative) {
			throw new ApiError("NO_NATIVE_HOST", "拡張機能環境ではないため native-host に接続できません");
		}
		let port: NativePort;
		try {
			port = runtime.connectNative(NATIVE_HOST_NAME);
		} catch (error) {
			throw toNativeConnectionError(error);
		}
		let disconnected = false;
		const pendingRejects = new Set<(error: ApiError) => void>();
		port.onDisconnect?.addListener(() => {
			disconnected = true;
			const error = new ApiError("NO_NATIVE_HOST", "native-hostとの接続が切れました");
			for (const reject of pendingRejects) reject(error);
			pendingRejects.clear();
		});

		return {
			send<T>(command: string, payload: unknown, timeoutMs = 15_000): Promise<T> {
				if (disconnected) {
					return Promise.reject(new ApiError("NO_NATIVE_HOST", "native-hostとの接続が切れました"));
				}
				const id = crypto.randomUUID();
				return new Promise<T>((resolve, reject) => {
					let chunkState: ChunkState | undefined;
					const rejectPending = (error: ApiError) => {
						clearTimeout(timeout);
						port.onMessage.removeListener?.(onMessage);
						pendingRejects.delete(rejectPending);
						reject(error);
					};
					const timeout = setTimeout(() => {
						rejectPending(new ApiError("TIMEOUT", `native-hostからの応答がありません: ${command}`));
					}, timeoutMs);
					const onMessage = (message: unknown) => {
						if ((!isEnvelope(message) && !isChunkEnvelope(message)) || message.id !== id) return;
						let resolvedMessage: unknown = message;
						if (isChunkEnvelope(message)) {
							try {
								const completed = consumeChunk(message, chunkState);
								chunkState = completed.state;
								if (!completed.envelope) return;
								resolvedMessage = completed.envelope;
							} catch {
								rejectPending(new ApiError("INVALID_RESPONSE", "native-hostの分割応答が不正です"));
								return;
							}
						} else if (chunkState) {
							rejectPending(new ApiError("INVALID_RESPONSE", "native-hostの分割応答が不正です"));
							return;
						}
						if (!isEnvelope(resolvedMessage)) return;
						clearTimeout(timeout);
						port.onMessage.removeListener?.(onMessage);
						pendingRejects.delete(rejectPending);
						if (resolvedMessage.ok) resolve(resolvedMessage.data as T);
						else reject(new ApiError(resolvedMessage.error.code, resolvedMessage.error.message));
					};
					pendingRejects.add(rejectPending);
					port.onMessage.addListener(onMessage);
					try {
						port.postMessage({ id, command, payload });
					} catch (error) {
						rejectPending(toNativeConnectionError(error));
					}
				});
			},
			disconnect() {
				if (disconnected) return;
				disconnected = true;
				try {
					port.disconnect();
				} catch {
					// 既にブラウザ側で切断済みなら追加処理は不要。
				}
			},
		};
	}

	async ping(): Promise<boolean> {
		const runtime = this.getChromeRuntime();
		if (!runtime?.connectNative) return false;
		try {
			const response = await this.send<PingResult>("ping", {});
			return response.protocolVersion === EXTENSION_RUNTIME_PROTOCOL_VERSION;
		} catch {
			return false;
		}
	}

	/**
	 * 拡張機能自身の起動情報をSQLiteへ記録する。
	 *
	 * FuzzyApiClientの通常データAPIには含めず、拡張機能backgroundからだけ呼び出す。
	 */
	reportExtensionRuntime(report: ExtensionRuntimeReport): Promise<ExtensionRuntimeObservation> {
		return this.send("reportExtensionRuntime", report);
	}

	getDashboard(): Promise<DashboardSummary> {
		return this.send("getDashboard", {});
	}

	getDeadlines(filter?: DeadlineFilter): Promise<Assignment[]> {
		return this.send("getDeadlines", { filter });
	}

	updateSubmissionStatus(assignmentId: number, submitted: boolean): Promise<{ ok: boolean }> {
		return this.send("updateSubmissionStatus", { assignmentId, submitted });
	}

	search(query: string): Promise<SearchResult[]> {
		return this.send("search", { query });
	}

	suggestSavePath(request: SuggestSavePathRequest): Promise<SaveSuggestion[]> {
		return this.send("suggestSavePath", request);
	}

	async checkSimilarFiles(request: CheckSimilarFilesRequest): Promise<SimilarFileMatch[]> {
		const contentBase64 = request.contentBase64;
		if (typeof contentBase64 !== "string") {
			throw new ApiError("INVALID_REQUEST", "類似照合用ファイルの内容が必要です");
		}
		const byteLength = decodedBase64Length(contentBase64);
		if (byteLength === null || byteLength <= 0 || byteLength > FILE_TRANSFER_LIMITS.maxFileBytes) {
			throw new ApiError("INVALID_REQUEST", "類似照合用ファイルのサイズが許容範囲外です");
		}

		const transferId = crypto.randomUUID();
		const session = this.openSession();
		try {
			await session.send("beginCheckSimilarFile", { transferId, byteLength });
			let chunkIndex = 0;
			for (let offset = 0; offset < contentBase64.length; offset += NATIVE_FILE_CHUNK_CHARACTERS) {
				await session.send("appendCheckSimilarFileChunk", {
					transferId,
					chunkIndex,
					dataBase64: contentBase64.slice(offset, offset + NATIVE_FILE_CHUNK_CHARACTERS),
				});
				chunkIndex += 1;
			}
			return await session.send<SimilarFileMatch[]>(
				"checkSimilarFiles",
				{ transferId, fileMeta: request.fileMeta },
				30_000,
			);
		} finally {
			session.disconnect();
		}
	}

	async saveFiles(request: SaveFilesRequest): Promise<SaveFilesResult> {
		if (request.files.length === 0) return { savedFileIds: [], failedFiles: [] };
		if (request.files.length > FILE_TRANSFER_LIMITS.maxFiles) {
			throw new ApiError("INVALID_REQUEST", "一度に保存できるファイル数を超えています");
		}
		const totalBytes = request.files.reduce((total, file) => total + file.byteLength, 0);
		if (
			request.files.some(
				(file) =>
					!Number.isSafeInteger(file.byteLength) ||
					file.byteLength <= 0 ||
					file.byteLength > FILE_TRANSFER_LIMITS.maxFileBytes,
			) ||
			totalBytes > FILE_TRANSFER_LIMITS.maxTransferBytes
		) {
			throw new ApiError("INVALID_REQUEST", "ファイル転送サイズが許容範囲外です");
		}

		const transferId = crypto.randomUUID();
		const session = this.openSession();
		try {
			await session.send("beginSaveFiles", {
				transferId,
				targetPath: request.targetPath,
				courseId: request.courseId,
				files: request.files.map(({ fileId, fileName, mimeType, byteLength }) => ({
					fileId,
					fileName,
					mimeType,
					byteLength,
				})),
			});
			for (const file of request.files) {
				let chunkIndex = 0;
				for (
					let offset = 0;
					offset < file.contentBase64.length;
					offset += NATIVE_FILE_CHUNK_CHARACTERS
				) {
					await session.send("appendSaveFileChunk", {
						transferId,
						fileId: file.fileId,
						chunkIndex,
						dataBase64: file.contentBase64.slice(offset, offset + NATIVE_FILE_CHUNK_CHARACTERS),
					});
					chunkIndex += 1;
				}
			}
			return await session.send<SaveFilesResult>("saveFiles", { transferId }, 30_000);
		} finally {
			session.disconnect();
		}
	}

	async extractZip(request: ExtractZipRequest): Promise<ExtractZipResult> {
		// 大容量ZIPの処理が通常要求と同じ接続・5秒timeoutを巻き込まないよう分離する。
		const session = this.openSession();
		try {
			return await session.send("extractZip", request, this.#zipExtractionTimeoutMs);
		} finally {
			session.disconnect();
		}
	}

	getRules(): Promise<RuleSet> {
		return this.send("getRules", {});
	}

	updateGlobalRule(request: UpdateGlobalRuleRequest): Promise<RuleUpdateResult> {
		return this.send("updateGlobalRule", request);
	}

	updateCourseRuleOverride(request: UpdateCourseRuleOverrideRequest): Promise<RuleUpdateResult> {
		return this.send("updateCourseRuleOverride", request);
	}

	updateCourseFolderName(
		request: UpdateCourseFolderNameRequest,
	): Promise<UpdateCourseFolderNameResult> {
		return this.send("updateCourseFolderName", request);
	}

	getRuleViolations(): Promise<RuleViolationListItem[]> {
		return this.send("getRuleViolations", {});
	}

	getDuplicateGroups(): Promise<DuplicateGroupListItem[]> {
		return this.send("getDuplicateGroups", {});
	}

	getNotificationRules(): Promise<NotificationRule[]> {
		return this.send("getNotificationRules", {});
	}

	updateNotificationRules(rules: NotificationRuleInput[]): Promise<NotificationRuleUpdateResult> {
		return this.send("updateNotificationRules", { rules });
	}

	syncMoodleAssignments(request: SyncMoodleAssignmentsRequest): Promise<DataSyncEvent> {
		return this.send("syncMoodleAssignments", request);
	}

	getLatestSyncEvent(): Promise<DataSyncEvent | null> {
		return this.send("getLatestSyncEvent", {});
	}

	getAssignmentChanges(sinceSyncEventId?: number): Promise<AssignmentChange[]> {
		return this.send("getAssignmentChanges", { sinceSyncEventId });
	}

	exportData(request: ExportDataRequest): Promise<ExportDataResult> {
		return this.send("exportData", request);
	}

	importData(request: ImportDataRequest): Promise<ImportDataResult> {
		return this.send("importData", request);
	}

	async rebuildLibrary(request: RebuildLibraryRequest): Promise<LibraryMaintenanceSummary> {
		// 再構築中に通常の5秒要求が同じFIFO接続で待たされ、そのtimeoutが再構築まで
		// 切断しないよう、この長時間処理だけ独立したnative-host sessionを使用する。
		const session = this.openSession();
		try {
			return await session.send("rebuildLibrary", request, this.#libraryMaintenanceTimeoutMs);
		} finally {
			session.disconnect();
		}
	}

	async reconcileCourseFiles(
		request: ReconcileCourseFilesRequest,
	): Promise<LibraryMaintenanceSummary> {
		const session = this.openSession();
		try {
			return await session.send("reconcileCourseFiles", request, this.#libraryMaintenanceTimeoutMs);
		} finally {
			session.disconnect();
		}
	}
}

function decodedBase64Length(value: string): number | null {
	if (value.length === 0 || value.length % 4 !== 0) return null;
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	const length = (value.length / 4) * 3 - padding;
	return Number.isSafeInteger(length) ? length : null;
}

function isEnvelope(value: unknown): value is Envelope<unknown> {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as {
		id?: unknown;
		ok?: unknown;
		data?: unknown;
		error?: { code?: unknown; message?: unknown };
	};
	if (typeof candidate.id !== "string" || typeof candidate.ok !== "boolean") return false;
	if (candidate.ok) return "data" in candidate;
	return typeof candidate.error?.code === "string" && typeof candidate.error.message === "string";
}

function isChunkEnvelope(value: unknown): value is ChunkEnvelope {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as {
		id?: unknown;
		ok?: unknown;
		chunk?: {
			index?: unknown;
			total?: unknown;
			encoding?: unknown;
			data?: unknown;
		};
	};
	const chunk = candidate.chunk;
	return (
		typeof candidate.id === "string" &&
		candidate.ok === true &&
		typeof chunk === "object" &&
		chunk !== null &&
		Number.isInteger(chunk.index) &&
		typeof chunk.index === "number" &&
		Number.isInteger(chunk.total) &&
		typeof chunk.total === "number" &&
		chunk.encoding === "base64" &&
		typeof chunk.data === "string"
	);
}

function consumeChunk(
	message: ChunkEnvelope,
	current: ChunkState | undefined,
): { state: ChunkState; envelope?: Envelope<unknown> } {
	const { index, total, data } = message.chunk;
	if (
		total < 2 ||
		total > MAX_RESPONSE_CHUNKS ||
		index < 0 ||
		index >= total ||
		data.length === 0
	) {
		throw new Error("invalid chunk metadata");
	}
	const bytes = decodeBase64(data);
	const state =
		current ??
		({
			total,
			chunks: Array.from({ length: total }),
			received: 0,
			byteLength: 0,
		} satisfies ChunkState);
	if (state.total !== total || state.chunks[index]) {
		throw new Error("inconsistent chunk sequence");
	}
	state.chunks[index] = bytes;
	state.received += 1;
	state.byteLength += bytes.byteLength;
	if (state.byteLength > MAX_REASSEMBLED_RESPONSE_BYTES) {
		throw new Error("response too large");
	}
	if (state.received !== state.total) return { state };

	const joined = new Uint8Array(state.byteLength);
	let offset = 0;
	for (const chunk of state.chunks) {
		if (!chunk) throw new Error("missing response chunk");
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
	if (!isEnvelope(parsed) || parsed.id !== message.id) {
		throw new Error("invalid rebuilt envelope");
	}
	return { state, envelope: parsed };
}

function decodeBase64(value: string): Uint8Array {
	const decodedLength = decodedBase64Length(value);
	if (decodedLength === null) throw new Error("invalid base64 length");
	const binary = atob(value);
	if (binary.length !== decodedLength) throw new Error("invalid base64 data");
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toNativeConnectionError(error: unknown): ApiError {
	return error instanceof ApiError
		? error
		: new ApiError("NO_NATIVE_HOST", "native-hostに接続できません");
}
