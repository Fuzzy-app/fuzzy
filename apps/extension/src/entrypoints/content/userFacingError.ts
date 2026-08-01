const technicalDetailPattern =
	/SQLite|データベース|\bDB\b|検索索引|派生検索索引|内部索引|native-host|Native Messaging|IndexedDB|background|service worker|chrome\.runtime|browser\.runtime|ターミナル|コマンド|通信仕様|プロトコル|\{(?:year|term|course|assignment|section)\}/i;

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
