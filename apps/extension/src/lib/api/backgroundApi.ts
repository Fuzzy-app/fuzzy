// content script と background の間で、Native Messagingが必要なAPIを中継する共有定義。
//
// 【背景】NativeApiClient は chrome.runtime.connectNative を使うが、これは
// content script からは利用できないため、content script で createApiClient() を
// 直接呼ぶと native-host 完成後も常にモックへフォールバックしてしまう。
// 仕様書3.4節「Moodleアクセス中のみ接続を維持」の方針とも合わせ、
// Native Messaging 接続は background(service worker) に集約し、
// content script からは runtime メッセージ経由で呼び出す。
import type {
	CheckSimilarFilesRequest,
	ExtractZipRequest,
	ExtractZipResult,
	FuzzyApiClient,
	NotificationRule,
	NotificationRuleInput,
	NotificationRuleUpdateResult,
	SaveFilesRequest,
	SaveFilesResult,
	SaveSuggestion,
	SimilarFileMatch,
	SuggestSavePathRequest,
} from "@fuzzy/shared";

export const FUZZY_API_MESSAGE_TYPE = "fuzzy:apiRequest";

const BACKGROUND_API_METHODS = [
	"suggestSavePath",
	"checkSimilarFiles",
	"saveFiles",
	"extractZip",
	"getNotificationRules",
	"updateNotificationRules",
] as const;

export type BackgroundApiMethod = (typeof BACKGROUND_API_METHODS)[number];

export interface FuzzyApiRequestMessage {
	type: typeof FUZZY_API_MESSAGE_TYPE;
	method: BackgroundApiMethod;
	request: unknown;
}

export type FuzzyApiResponseMessage<T = unknown> =
	| { ok: true; data: T; mode: FuzzyApiClient["mode"] }
	| { ok: false; error: string };

export function isFuzzyApiRequestMessage(message: unknown): message is FuzzyApiRequestMessage {
	if (typeof message !== "object" || message === null) return false;
	const candidate = message as { type?: unknown; method?: unknown };
	return (
		candidate.type === FUZZY_API_MESSAGE_TYPE &&
		typeof candidate.method === "string" &&
		(BACKGROUND_API_METHODS as readonly string[]).includes(candidate.method)
	);
}

/** background経由で呼び出せるAPIの部分集合。 */
type BackgroundApi = Pick<FuzzyApiClient, BackgroundApiMethod>;

/**
 * background経由で対象APIを呼ぶ、content script用のクライアント。
 * メソッドのシグネチャは FuzzyApiClient の該当メソッドと同一。
 */
export class BackgroundApiClient implements BackgroundApi {
	/** 直近の応答で判明した接続モード。応答を受け取るまでは "unknown"。 */
	#mode: FuzzyApiClient["mode"] | "unknown" = "unknown";

	get mode(): FuzzyApiClient["mode"] | "unknown" {
		return this.#mode;
	}

	suggestSavePath(request: SuggestSavePathRequest): Promise<SaveSuggestion[]> {
		return this.#call("suggestSavePath", request);
	}

	checkSimilarFiles(request: CheckSimilarFilesRequest): Promise<SimilarFileMatch[]> {
		return this.#call("checkSimilarFiles", request);
	}

	saveFiles(request: SaveFilesRequest): Promise<SaveFilesResult> {
		return this.#call("saveFiles", request);
	}

	extractZip(request: ExtractZipRequest): Promise<ExtractZipResult> {
		return this.#call("extractZip", request);
	}

	getNotificationRules(): Promise<NotificationRule[]> {
		return this.#call("getNotificationRules", {});
	}

	updateNotificationRules(rules: NotificationRuleInput[]): Promise<NotificationRuleUpdateResult> {
		return this.#call("updateNotificationRules", rules);
	}

	async #call<T>(method: BackgroundApiMethod, request: unknown): Promise<T> {
		const message: FuzzyApiRequestMessage = { type: FUZZY_API_MESSAGE_TYPE, method, request };
		const response = (await browser.runtime.sendMessage(message)) as
			| FuzzyApiResponseMessage<T>
			| undefined;

		if (!response) throw new Error("backgroundからの応答がありません");
		if (!response.ok) throw new Error(response.error);

		this.#mode = response.mode;
		return response.data;
	}
}
