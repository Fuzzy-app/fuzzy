import type {
	Assignment,
	AssignmentChange,
	CheckSimilarFilesRequest,
	DashboardSummary,
	DataSyncEvent,
	DeadlineFilter,
	DuplicateGroup,
	ExtractZipRequest,
	ExtractZipResult,
	NotificationRule,
	RuleSet,
	RuleViolation,
	SaveFilesRequest,
	SaveFilesResult,
	SaveSuggestion,
	SearchResult,
	SimilarFileMatch,
	SuggestSavePathRequest,
} from "../types";
import type { FuzzyApiClient } from "./client";
import { ApiError } from "./client";

const NATIVE_HOST_NAME = "jp.ac.wakayama_u.fuzzy.native_host";

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

	saveFiles(request: SaveFilesRequest): Promise<SaveFilesResult> {
		return this.send("saveFiles", request);
	}

	extractZip(request: ExtractZipRequest): Promise<ExtractZipResult> {
		return this.send("extractZip", request);
	}

	getRules(): Promise<RuleSet> {
		return this.send("getRules", {});
	}

	getRuleViolations(): Promise<RuleViolation[]> {
		return this.send("getRuleViolations", {});
	}

	getDuplicateGroups(): Promise<DuplicateGroup[]> {
		return this.send("getDuplicateGroups", {});
	}

	getNotificationRules(): Promise<NotificationRule[]> {
		return this.send("getNotificationRules", {});
	}

	updateNotificationRules(rules: NotificationRule[]): Promise<{ ok: boolean }> {
		return this.send("updateNotificationRules", { rules });
	}

	getLatestSyncEvent(): Promise<DataSyncEvent | null> {
		return this.send("getLatestSyncEvent", {});
	}

	getAssignmentChanges(sinceSyncEventId?: number): Promise<AssignmentChange[]> {
		return this.send("getAssignmentChanges", { sinceSyncEventId });
	}
}
