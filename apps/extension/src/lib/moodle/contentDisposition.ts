const MAX_CONTENT_DISPOSITION_LENGTH = 8_192;
const MAX_WINDOWS_FILE_NAME_UTF16_UNITS = 255;

/**
 * Content-Dispositionのfilename*を優先し、安全な表示用ファイル名だけを返す。
 * RFC 5987形式のcharset、旧式のRFC 2047、生UTF-8をLatin-1として受け取った
 * ヘッダーを同じ境界で復元し、一覧表示と実保存名の文字コード処理を一致させる。
 */
export function contentDispositionFileName(value: string | null): string | null {
	if (!value || value.length > MAX_CONTENT_DISPOSITION_LENGTH) return null;
	const parameters = parseParameters(value);
	const extended = parameters.get("filename*");
	const regular = parameters.get("filename");
	const decoded =
		(extended ? decodeExtendedFileName(extended) : null) ??
		(regular ? decodeLegacyFileName(regular) : null);
	const fileName = decoded?.replaceAll("\\", "/").split("/").pop()?.trim().normalize("NFC") ?? "";
	if (
		!fileName ||
		fileName === "." ||
		fileName === ".." ||
		[...fileName].some((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint < 32 || (codePoint >= 0x7f && codePoint <= 0x9f);
		})
	) {
		return null;
	}
	return truncateFileName(fileName, MAX_WINDOWS_FILE_NAME_UTF16_UNITS);
}

function parseParameters(value: string): Map<string, string> {
	const parameters = new Map<string, string>();
	const parameterPattern =
		/(?:^|;)\s*([!#$%&'*+\-.^_`|~0-9A-Za-z]+)\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]*))/g;
	for (const match of value.matchAll(parameterPattern)) {
		const name = match[1]?.toLowerCase();
		const rawValue = match[2]?.replace(/\\(["\\])/g, "$1") ?? match[3]?.trim();
		if (name && rawValue !== undefined && !parameters.has(name)) {
			parameters.set(name, rawValue);
		}
	}
	return parameters;
}

function decodeExtendedFileName(value: string): string | null {
	const firstSeparator = value.indexOf("'");
	const secondSeparator = value.indexOf("'", firstSeparator + 1);
	if (firstSeparator <= 0 || secondSeparator < 0) return null;
	const charset = value.slice(0, firstSeparator).trim();
	const encoded = value.slice(secondSeparator + 1);
	const bytes = percentEncodedBytes(encoded);
	return bytes ? decodeHeaderBytes(bytes, charset) : null;
}

function decodeLegacyFileName(value: string): string | null {
	const encodedWord = decodeRfc2047Word(value);
	if (encodedWord !== null) return encodedWord;
	const percentDecoded = /%[0-9a-f]{2}/i.test(value) ? safeDecodeURIComponent(value) : value;
	return repairUtf8HeaderMojibake(percentDecoded);
}

function decodeRfc2047Word(value: string): string | null {
	const match = value.trim().match(/^=\?([^?]+)\?([bq])\?([^?]*)\?=$/i);
	if (!match?.[1] || !match[2] || match[3] === undefined) return null;
	try {
		const encoded = match[3];
		const bytes =
			match[2].toLowerCase() === "b"
				? Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
				: quotedPrintableBytes(encoded);
		return bytes ? decodeHeaderBytes(bytes, match[1]) : null;
	} catch {
		return null;
	}
}

function percentEncodedBytes(value: string): Uint8Array | null {
	const bytes: number[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index] ?? "";
		if (character === "%") {
			const hex = value.slice(index + 1, index + 3);
			if (!/^[0-9a-f]{2}$/i.test(hex)) return null;
			bytes.push(Number.parseInt(hex, 16));
			index += 2;
			continue;
		}
		const codePoint = character.charCodeAt(0);
		if (codePoint > 0x7f) return null;
		bytes.push(codePoint);
	}
	return Uint8Array.from(bytes);
}

function quotedPrintableBytes(value: string): Uint8Array | null {
	const bytes: number[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index] ?? "";
		if (character === "_") {
			bytes.push(0x20);
			continue;
		}
		if (character === "=") {
			const hex = value.slice(index + 1, index + 3);
			if (!/^[0-9a-f]{2}$/i.test(hex)) return null;
			bytes.push(Number.parseInt(hex, 16));
			index += 2;
			continue;
		}
		const codePoint = character.charCodeAt(0);
		if (codePoint > 0xff) return null;
		bytes.push(codePoint);
	}
	return Uint8Array.from(bytes);
}

function decodeHeaderBytes(bytes: Uint8Array, charset: string): string | null {
	try {
		return new TextDecoder(charset, { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

function repairUtf8HeaderMojibake(value: string): string {
	const hasMojibakeMarker = [...value].some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return (codePoint >= 0x80 && codePoint <= 0x9f) || "ÃÂã".includes(character);
	});
	if (!hasMojibakeMarker || [...value].some((character) => character.charCodeAt(0) > 0xff)) {
		return value;
	}
	const bytes = Uint8Array.from(value, (character) => character.charCodeAt(0));
	return decodeHeaderBytes(bytes, "utf-8") ?? value;
}

function safeDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function truncateUtf16(value: string, maximumUnits: number): string {
	if (value.length <= maximumUnits) return value;
	const truncated = value.slice(0, maximumUnits);
	const lastUnit = truncated.charCodeAt(truncated.length - 1);
	return lastUnit >= 0xd800 && lastUnit <= 0xdbff ? truncated.slice(0, -1) : truncated;
}

function truncateFileName(value: string, maximumUnits: number): string {
	if (value.length <= maximumUnits) return value;
	const extension = value.match(/\.[a-z0-9]{1,10}$/i)?.[0] ?? "";
	return `${truncateUtf16(value.slice(0, -extension.length), maximumUnits - extension.length)}${extension}`;
}
