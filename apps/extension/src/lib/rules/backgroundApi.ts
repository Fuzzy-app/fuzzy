import type {
	DuplicateGroupListItem,
	ExcludedFolder,
	RuleUpdateResult,
	RuleViolationListItem,
} from "@fuzzy/shared";
import { ApiError } from "@fuzzy/shared";
import type {
	RuleManagementApi,
	RuleSet,
	UpdateCourseRuleOverrideRequest,
	UpdateExcludedFoldersRequest,
	UpdateGlobalRuleRequest,
} from "./types";

export const FUZZY_RULE_MANAGEMENT_MESSAGE_TYPE = "fuzzy:ruleManagementRequest";

const RULE_MANAGEMENT_METHODS = [
	"getRules",
	"updateGlobalRule",
	"updateCourseRuleOverride",
	"clearCourseRuleOverride",
	"getExcludedFolders",
	"updateExcludedFolders",
	"getRuleViolations",
	"getDuplicateGroups",
] as const;

export type RuleManagementMethod = (typeof RULE_MANAGEMENT_METHODS)[number];

export interface RuleManagementRequestMessage {
	type: typeof FUZZY_RULE_MANAGEMENT_MESSAGE_TYPE;
	method: RuleManagementMethod;
	request: unknown;
}

export type RuleManagementResponseMessage<T = unknown> =
	| { ok: true; data: T; mode: RuleManagementApi["mode"] }
	| { ok: false; error: string };

export interface RuleManagementMessageTransport {
	sendMessage(message: RuleManagementRequestMessage): Promise<unknown>;
}

export function isRuleManagementRequestMessage(
	message: unknown,
): message is RuleManagementRequestMessage {
	if (typeof message !== "object" || message === null) return false;
	const candidate = message as { type?: unknown; method?: unknown };
	return (
		candidate.type === FUZZY_RULE_MANAGEMENT_MESSAGE_TYPE &&
		typeof candidate.method === "string" &&
		(RULE_MANAGEMENT_METHODS as readonly string[]).includes(candidate.method)
	);
}

/** background の単一APIへ処理を集約し、複数タブ間の更新競合を防ぐ。 */
export async function respondToRuleManagementRequest(
	apiPromise: Promise<RuleManagementApi>,
	message: RuleManagementRequestMessage,
	onError?: (error: unknown) => void,
): Promise<RuleManagementResponseMessage> {
	try {
		const api = await apiPromise;
		let data: unknown;
		switch (message.method) {
			case "getRules":
				data = await api.getRules();
				break;
			case "updateGlobalRule":
				data = await api.updateGlobalRule(message.request as UpdateGlobalRuleRequest);
				break;
			case "updateCourseRuleOverride":
				data = await api.updateCourseRuleOverride(
					message.request as UpdateCourseRuleOverrideRequest,
				);
				break;
			case "clearCourseRuleOverride":
				data = await api.clearCourseRuleOverride(
					(message.request as { courseId: number }).courseId,
				);
				break;
			case "getExcludedFolders":
				data = await api.getExcludedFolders((message.request as { courseId?: number }).courseId);
				break;
			case "updateExcludedFolders":
				data = await api.updateExcludedFolders(message.request as UpdateExcludedFoldersRequest);
				break;
			case "getRuleViolations":
				data = await api.getRuleViolations();
				break;
			case "getDuplicateGroups":
				data = await api.getDuplicateGroups();
				break;
		}
		return { ok: true, data, mode: api.mode };
	} catch (error) {
		onError?.(error);
		return {
			ok: false,
			error: error instanceof ApiError ? error.message : "ルールAPIの呼び出しに失敗しました。",
		};
	}
}

/** content script から background のルールAPIを呼ぶクライアント。 */
export class BackgroundRuleManagementApi implements RuleManagementApi {
	readonly #transport: RuleManagementMessageTransport;
	#mode: RuleManagementApi["mode"] = "native";

	constructor(transport: RuleManagementMessageTransport) {
		this.#transport = transport;
	}

	get mode(): RuleManagementApi["mode"] {
		return this.#mode;
	}

	getRules(): Promise<RuleSet> {
		return this.#call("getRules", {});
	}

	updateGlobalRule(request: UpdateGlobalRuleRequest): Promise<RuleUpdateResult> {
		return this.#call("updateGlobalRule", request);
	}

	updateCourseRuleOverride(request: UpdateCourseRuleOverrideRequest): Promise<RuleUpdateResult> {
		return this.#call("updateCourseRuleOverride", request);
	}

	clearCourseRuleOverride(courseId: number): Promise<RuleUpdateResult> {
		return this.#call("clearCourseRuleOverride", { courseId });
	}

	getExcludedFolders(courseId?: number): Promise<ExcludedFolder[]> {
		return this.#call("getExcludedFolders", courseId === undefined ? {} : { courseId });
	}

	updateExcludedFolders(request: UpdateExcludedFoldersRequest): Promise<ExcludedFolder[]> {
		return this.#call("updateExcludedFolders", request);
	}

	getRuleViolations(): Promise<RuleViolationListItem[]> {
		return this.#call("getRuleViolations", {});
	}

	getDuplicateGroups(): Promise<DuplicateGroupListItem[]> {
		return this.#call("getDuplicateGroups", {});
	}

	async #call<T>(method: RuleManagementMethod, request: unknown): Promise<T> {
		const response = await this.#transport.sendMessage({
			type: FUZZY_RULE_MANAGEMENT_MESSAGE_TYPE,
			method,
			request,
		});
		if (!isResponseMessage(response)) throw new Error("backgroundからの応答がありません。");
		if (!response.ok) throw new Error(response.error);

		this.#mode = response.mode;
		return response.data as T;
	}
}

/** 拡張機能外の画面確認・テストではnullを返し、呼び出し側で接続不可として扱う。 */
export function createBackgroundRuleManagementApi(): RuleManagementApi | null {
	const transport = createRuntimeTransport();
	return transport ? new BackgroundRuleManagementApi(transport) : null;
}

function isResponseMessage(value: unknown): value is RuleManagementResponseMessage {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { ok?: unknown; error?: unknown; mode?: unknown };
	if (candidate.ok === false) return typeof candidate.error === "string";
	return (
		candidate.ok === true &&
		(candidate.mode === "mock" || candidate.mode === "native") &&
		"data" in value
	);
}

interface BrowserRuntimeLike {
	sendMessage(message: unknown): Promise<unknown>;
}

interface ChromeRuntimeLike {
	lastError?: { message?: string };
	sendMessage(message: unknown, callback: (response: unknown) => void): void;
}

function createRuntimeTransport(): RuleManagementMessageTransport | null {
	const extensionRuntime = globalThis as typeof globalThis & {
		browser?: { runtime?: BrowserRuntimeLike };
		chrome?: { runtime?: ChromeRuntimeLike };
	};
	const browserRuntime = extensionRuntime.browser?.runtime;
	if (browserRuntime) {
		return {
			sendMessage(message): Promise<unknown> {
				return browserRuntime.sendMessage(message);
			},
		};
	}

	const chromeRuntime = extensionRuntime.chrome?.runtime;
	if (!chromeRuntime) return null;
	return {
		sendMessage(message): Promise<unknown> {
			return new Promise((resolve, reject) => {
				chromeRuntime.sendMessage(message, (response) => {
					const errorMessage = chromeRuntime.lastError?.message;
					if (errorMessage) reject(new Error(errorMessage));
					else resolve(response);
				});
			});
		},
	};
}
