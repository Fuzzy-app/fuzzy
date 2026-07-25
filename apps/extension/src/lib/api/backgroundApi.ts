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
	MoodleSaveFilesRequest,
	NotificationRule,
	NotificationRuleInput,
	NotificationRuleUpdateResult,
	SaveFilesResult,
	SaveSuggestion,
	SimilarFileMatch,
	SuggestSavePathRequest,
	UpdateCourseFolderNameRequest,
	UpdateCourseFolderNameResult,
} from "@fuzzy/shared";
import { ApiError } from "@fuzzy/shared";
import { FILE_TRANSFER_LIMITS } from "@fuzzy/shared";

export const FUZZY_API_MESSAGE_TYPE = "fuzzy:apiRequest";

const BACKGROUND_API_METHODS = [
	"suggestSavePath",
	"updateCourseFolderName",
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
	| { ok: false; error: { code: string; message: string } };

export function isFuzzyApiRequestMessage(message: unknown): message is FuzzyApiRequestMessage {
	if (typeof message !== "object" || message === null) return false;
	const candidate = message as { type?: unknown; method?: unknown; request?: unknown };
	return (
		candidate.type === FUZZY_API_MESSAGE_TYPE &&
		typeof candidate.method === "string" &&
		(BACKGROUND_API_METHODS as readonly string[]).includes(candidate.method) &&
		"request" in candidate
	);
}

export function hasValidFuzzyApiRequestPayload(message: FuzzyApiRequestMessage): boolean {
	return isRequestForMethod(message.method, message.request);
}

function isRequestForMethod(method: BackgroundApiMethod, request: unknown): boolean {
	switch (method) {
		case "suggestSavePath":
			return (
				isRecord(request) &&
				isMoodleCourseContext(request.course) &&
				(request.fileMeta === undefined ||
					request.fileMeta === null ||
					isMoodleFileMeta(request.fileMeta))
			);
		case "updateCourseFolderName":
			return (
				isRecord(request) &&
				isPositiveInteger(request.courseId) &&
				(request.folderName === null || typeof request.folderName === "string")
			);
		case "checkSimilarFiles":
			return isRecord(request) && isMoodleFileMeta(request.fileMeta);
		case "saveFiles":
			return (
				isRecord(request) &&
				typeof request.targetPath === "string" &&
				(request.courseId === null || isPositiveInteger(request.courseId)) &&
				Array.isArray(request.files) &&
				request.files.length > 0 &&
				request.files.length <= FILE_TRANSFER_LIMITS.maxFiles &&
				request.files.every(isMoodleFileMeta)
			);
		case "extractZip":
			return (
				isRecord(request) &&
				isMoodleFileMeta(request.fileMeta) &&
				typeof request.targetPath === "string" &&
				typeof request.destinationPath === "string" &&
				typeof request.flatten === "boolean"
			);
		case "getNotificationRules":
			return isRecord(request);
		case "updateNotificationRules":
			return (
				Array.isArray(request) &&
				request.every(
					(rule) =>
						isRecord(rule) &&
						(rule.id === undefined || isPositiveInteger(rule.id)) &&
						Number.isSafeInteger(rule.offsetMinutes) &&
						typeof rule.enabled === "boolean",
				)
			);
	}
}

function isMoodleCourseContext(value: unknown): boolean {
	return (
		isRecord(value) &&
		isNullableString(value.moodleCourseId) &&
		isNullableString(value.name) &&
		(value.academicYear === undefined ||
			value.academicYear === null ||
			(Number.isSafeInteger(value.academicYear) &&
				Number(value.academicYear) >= 1900 &&
				Number(value.academicYear) <= 9999)) &&
		isNullableString(value.term) &&
		isNullableString(value.sectionTitle) &&
		Array.isArray(value.breadcrumbs) &&
		value.breadcrumbs.every((item) => typeof item === "string")
	);
}

function isMoodleFileMeta(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.title === "string" &&
		typeof value.url === "string" &&
		isNullableString(value.moodleFileId) &&
		isNullableString(value.sectionTitle) &&
		isNullableString(value.mimeHint)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): boolean {
	return value === undefined || value === null || typeof value === "string";
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0;
}

/** background経由で呼び出せるAPIの部分集合。 */
type BackgroundApi = Pick<FuzzyApiClient, Exclude<BackgroundApiMethod, "saveFiles">> & {
	saveFiles(request: MoodleSaveFilesRequest): Promise<SaveFilesResult>;
};

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

	updateCourseFolderName(
		request: UpdateCourseFolderNameRequest,
	): Promise<UpdateCourseFolderNameResult> {
		return this.#call("updateCourseFolderName", request);
	}

	checkSimilarFiles(request: CheckSimilarFilesRequest): Promise<SimilarFileMatch[]> {
		return this.#call("checkSimilarFiles", request);
	}

	saveFiles(request: MoodleSaveFilesRequest): Promise<SaveFilesResult> {
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
		if (!response.ok) throw new ApiError(response.error.code, response.error.message);

		this.#mode = response.mode;
		return response.data;
	}
}

/**
 * background境界で内部例外の生文字列をcontent scriptへ返さない。
 * ApiErrorの公開コードだけを保ち、それ以外は固定文言へ畳み込む。
 */
export function toBackgroundApiError(error: unknown): { code: string; message: string } {
	if (error instanceof ApiError) {
		return { code: error.code, message: error.message };
	}
	return { code: "INTERNAL", message: "APIの呼び出しに失敗しました" };
}
