import {
	type CheckSimilarFilesRequest,
	type ExtractZipRequest,
	type FuzzyApiClient,
	type SaveFilesRequest,
	type SuggestSavePathRequest,
	createApiClient,
} from "@fuzzy/shared";
import {
	type FuzzyApiRequestMessage,
	type FuzzyApiResponseMessage,
	isFuzzyApiRequestMessage,
} from "../lib/api/backgroundApi";

// Native Messaging接続（native-host疎通）はbackgroundに集約する（仕様書3.4節）。
// content script側は lib/api/backgroundApi.ts の BackgroundApiClient から
// runtimeメッセージでここへ委譲する。
export default defineBackground(() => {
	let clientPromise: Promise<FuzzyApiClient> | null = null;
	const getClient = (): Promise<FuzzyApiClient> => {
		if (!clientPromise) clientPromise = createApiClient();
		return clientPromise;
	};

	browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
		if (!isFuzzyApiRequestMessage(message)) return false;

		void respondToApiRequest(getClient(), message).then(sendResponse);
		return true; // sendResponse を非同期に呼ぶため、メッセージチャネルを維持する
	});
});

async function respondToApiRequest(
	clientPromise: Promise<FuzzyApiClient>,
	message: FuzzyApiRequestMessage,
): Promise<FuzzyApiResponseMessage> {
	try {
		const client = await clientPromise;
		const data = await callSaveApi(client, message);
		return { ok: true, data, mode: client.mode };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : "APIの呼び出しに失敗しました",
		};
	}
}

// リクエスト本文はメッセージ境界を越えるため実行時には型情報が失われている。
// メソッド名で分岐し、各APIの想定型として渡す（内容の検証はnative-host側の契約に委ねる）。
function callSaveApi(client: FuzzyApiClient, message: FuzzyApiRequestMessage): Promise<unknown> {
	switch (message.method) {
		case "suggestSavePath":
			return client.suggestSavePath(message.request as SuggestSavePathRequest);
		case "checkSimilarFiles":
			return client.checkSimilarFiles(message.request as CheckSimilarFilesRequest);
		case "saveFiles":
			return client.saveFiles(message.request as SaveFilesRequest);
		case "extractZip":
			return client.extractZip(message.request as ExtractZipRequest);
	}
}
