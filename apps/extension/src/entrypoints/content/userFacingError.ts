import { ApiError } from "@fuzzy/shared";

const technicalDetailPattern =
	/SQLite|データベース|\bDB\b|検索索引|派生検索索引|内部索引|native-host|Native Messaging|IndexedDB|background|service worker|chrome\.runtime|browser\.runtime|ターミナル|コマンド|通信仕様|プロトコル|\{(?:year|term|course|assignment|section)\}/i;

export interface NativeConnectionIssuePresentation {
	statusLabel: string;
	title: string;
	impact: string;
}

/** Native Messagingの公開エラーコードだけを、利用者が復旧できる説明へ変換する。 */
export function nativeConnectionIssuePresentation(
	error: unknown,
): NativeConnectionIssuePresentation | null {
	if (!(error instanceof ApiError)) return null;

	if (error.code === "NO_NATIVE_HOST") {
		return {
			statusLabel: "Fuzzy本体に接続できません",
			title: "Fuzzy本体と接続できませんでした。",
			impact:
				"同じ対応バージョンのFuzzyを起動して初期設定を確認してください。「接続を自動修復」が表示された場合は実行し、ブラウザとMoodleを開き直してください。解消しない場合はFuzzyの復旧画面または再インストールを利用してください。",
		};
	}
	if (error.code === "TIMEOUT") {
		return {
			statusLabel: "Fuzzy本体から応答がありません",
			title: "Fuzzy本体から応答がありませんでした。",
			impact: "同じ対応バージョンのFuzzyを一度起動してから、ブラウザとMoodleを開き直してください。",
		};
	}
	return null;
}

export function userFacingErrorMessage(
	error: unknown,
	fallback: string,
	options: { prefixFallback?: boolean } = {},
): string {
	const detail =
		error instanceof Error ? error.message.trim() : typeof error === "string" ? error.trim() : "";
	if (!detail || technicalDetailPattern.test(detail)) return fallback;
	return options.prefixFallback ? `${fallback} ${detail}` : detail;
}
