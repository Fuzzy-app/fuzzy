import type {
	Assignment,
	AssignmentChange,
	CheckSimilarFilesRequest,
	DashboardSummary,
	DataSyncEvent,
	DeadlineFilter,
	DuplicateGroupListItem,
	ExtensionRuntimeObservation,
	ExtensionRuntimeReport,
	ExtractZipRequest,
	ExtractZipResult,
	NotificationRule,
	NotificationRuleInput,
	NotificationRuleUpdateResult,
	RuleSet,
	RuleUpdateResult,
	RuleViolationListItem,
	SaveFilesRequest,
	SaveFilesResult,
	SaveSuggestion,
	SearchResult,
	SimilarFileMatch,
	SuggestSavePathRequest,
	UpdateCourseFolderNameRequest,
	UpdateCourseFolderNameResult,
	UpdateCourseRuleOverrideRequest,
	UpdateGlobalRuleRequest,
} from "../types";
import type { FuzzyApiClient } from "./client";
import { ApiError } from "./client";

const NATIVE_HOST_NAME = "jp.ac.wakayama_u.fuzzy.native_host";
/** Firefox/Chrome双方のNative Messaging上限を十分下回るbase64チャンク長。 */
const NATIVE_FILE_CHUNK_CHARACTERS = 192 * 1024;

type Envelope<T> =
	| { id: string; ok: true; data: T }
	| {
			id: string;
			ok: false;
			error: { code: string; message: string };
	  };

/**
 * Native Messaging 経由で native-host（Rustエンジン）と通信する本番実装。
 * docs/api/contract.md の envelope 形式に従う。
 * 拡張機能（chrome.runtime）が存在しない環境（Node等）では ping() が常に false を返し、
 * createApiClient() がフォールバックを判断できるようにする。
 */
export class NativeApiClient implements FuzzyApiClient {
	readonly mode = "native" as const;
	private port: unknown | null = null;

	private getChromeRuntime(): { connectNative?: (name: string) => unknown } | undefined {
		// biome-ignore lint/suspicious/noExplicitAny: 拡張機能環境以外ではchromeが存在しないため
		return (globalThis as any).chrome?.runtime;
	}

	private send<T>(command: string, payload: unknown): Promise<T> {
		const runtime = this.getChromeRuntime();
		if (!runtime?.connectNative) {
			return Promise.reject(
				new ApiError("NO_NATIVE_HOST", "拡張機能環境ではないため native-host に接続できません"),
			);
		}
		const id = crypto.randomUUID();
		return new Promise<T>((resolve, reject) => {
			// biome-ignore lint/suspicious/noExplicitAny: chrome.runtime.Portの型はapps/extension側で@types/chromeにより補完する
			const port = runtime.connectNative?.(NATIVE_HOST_NAME) as any;
			const timeout = setTimeout(() => {
				reject(new ApiError("TIMEOUT", `native-hostからの応答がありません: ${command}`));
			}, 5000);
			port.onMessage.addListener((msg: Envelope<T>) => {
				if (msg.id !== id) return;
				clearTimeout(timeout);
				port.disconnect();
				if (msg.ok) resolve(msg.data);
				else reject(new ApiError(msg.error.code, msg.error.message));
			});
			port.postMessage({ id, command, payload });
		});
	}

	private openSession(): {
		send<T>(command: string, payload: unknown, timeoutMs?: number): Promise<T>;
		disconnect(): void;
	} {
		const runtime = this.getChromeRuntime();
		if (!runtime?.connectNative) {
			throw new ApiError("NO_NATIVE_HOST", "拡張機能環境ではないため native-host に接続できません");
		}
		// biome-ignore lint/suspicious/noExplicitAny: chrome.runtime.Portは拡張機能実行時だけ存在する
		const port = runtime.connectNative(NATIVE_HOST_NAME) as any;
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
					const rejectPending = (error: ApiError) => {
						clearTimeout(timeout);
						port.onMessage.removeListener(onMessage);
						pendingRejects.delete(rejectPending);
						reject(error);
					};
					const timeout = setTimeout(() => {
						rejectPending(new ApiError("TIMEOUT", `native-hostからの応答がありません: ${command}`));
					}, timeoutMs);
					const onMessage = (message: Envelope<T>) => {
						if (message.id !== id) return;
						clearTimeout(timeout);
						port.onMessage.removeListener(onMessage);
						pendingRejects.delete(rejectPending);
						if (message.ok) resolve(message.data);
						else reject(new ApiError(message.error.code, message.error.message));
					};
					pendingRejects.add(rejectPending);
					port.onMessage.addListener(onMessage);
					port.postMessage({ id, command, payload });
				});
			},
			disconnect() {
				if (disconnected) return;
				disconnected = true;
				port.disconnect();
			},
		};
	}

	async ping(): Promise<boolean> {
		const runtime = this.getChromeRuntime();
		if (!runtime?.connectNative) return false;
		try {
			await this.send<{ version: string }>("ping", {});
			return true;
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

	checkSimilarFiles(request: CheckSimilarFilesRequest): Promise<SimilarFileMatch[]> {
		return this.send("checkSimilarFiles", request);
	}

	async saveFiles(request: SaveFilesRequest): Promise<SaveFilesResult> {
		if (request.files.length === 0) return { savedFileIds: [], failedFiles: [] };

		const transferId = crypto.randomUUID();
		const session = this.openSession();
		try {
			await session.send("beginSaveFiles", {
				transferId,
				targetPath: request.targetPath,
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

	extractZip(request: ExtractZipRequest): Promise<ExtractZipResult> {
		return this.send("extractZip", request);
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

	getLatestSyncEvent(): Promise<DataSyncEvent | null> {
		return this.send("getLatestSyncEvent", {});
	}

	getAssignmentChanges(sinceSyncEventId?: number): Promise<AssignmentChange[]> {
		return this.send("getAssignmentChanges", { sinceSyncEventId });
	}
}
