/** 全角・半角、大小文字、空白、句読点を吸収する検索用文字列。 */
export function normalizeSearchText(value: string): string {
	return Array.from(value.normalize("NFKC").toLocaleLowerCase("ja-JP"))
		.filter((character) => /[\p{Letter}\p{Number}]/u.test(character))
		.join("");
}

/** 原文を最優先に保ちつつ、英数字語と日本語述語の間の助詞を外した検索候補も返す。 */
export function buildSearchQueryVariants(value: string): string[] {
	const original = value.normalize("NFKC").replace(/\s+/g, " ").trim();
	if (!original) return [];
	const withoutParticle = original.replace(
		/([A-Za-z][A-Za-z0-9+#._-]*)\s*(?:を|に|へ|で|と|が|は)\s*(?=[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}])/gu,
		"$1 ",
	);
	return [...new Set([original, withoutParticle].filter(Boolean))];
}
