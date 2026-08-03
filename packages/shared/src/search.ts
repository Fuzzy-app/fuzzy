/** 全角・半角、大小文字、空白、句読点を吸収する検索用文字列。 */
export function normalizeSearchText(value: string): string {
	return Array.from(value.normalize("NFKC").toLocaleLowerCase("ja-JP"))
		.filter((character) => /[\p{Letter}\p{Number}]/u.test(character))
		.join("");
}
