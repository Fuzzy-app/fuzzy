const WINDOWS_ABSOLUTE_PATH_PATTERN = /^(?:[a-z]:[\\/]|[\\/]{2})/i;
const WINDOWS_INVALID_CHARACTER_PATTERN = /[<>:"|?*]/;
const WINDOWS_RESERVED_NAME_PATTERN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** Windowsパスを比較・API送信用のバックスラッシュ表記へ正規化する。 */
export function normalizeWindowsPath(path: string): string {
	const trimmed = path.trim();
	if (!trimmed) return "";
	const isUnc = /^[\\/]{2}/.test(trimmed);
	const normalized = trimmed.replace(/[\\/]+/g, "\\").replace(/\\+$/, "");
	return isUnc ? `\\\\${normalized.replace(/^\\+/, "")}` : normalized;
}

/** 大文字小文字・区切り文字の違いを無視してWindowsパスを比較するためのキーを返す。 */
export function canonicalWindowsPath(path: string): string {
	return normalizeWindowsPath(path).toLocaleLowerCase("en-US");
}

/** Windowsパスの各階層を、UIのパンくず表示に使える配列へ分割する。 */
export function splitWindowsPath(path: string): string[] {
	return normalizeWindowsPath(path)
		.replace(/^[a-z]:\\/i, "")
		.replace(/^\\\\/, "")
		.split("\\")
		.filter(Boolean);
}

/** 保存ルートと相対パスを安全に結合する。不正な相対パスはnullを返す。 */
export function resolveSavePathUnderRoot(basePath: string, relativePath: string): string | null {
	const normalizedBase = normalizeWindowsPath(basePath);
	const normalizedRelative = normalizeRelativeSavePath(relativePath);
	if (!normalizedBase || normalizedRelative === null) return null;
	return normalizedRelative ? `${normalizedBase}\\${normalizedRelative}` : normalizedBase;
}

/** 保存ルート以下に限定された相対パスを検証・正規化する。 */
export function normalizeRelativeSavePath(path: string): string | null {
	const trimmed = path.trim();
	if (!trimmed) return "";
	if (WINDOWS_ABSOLUTE_PATH_PATTERN.test(trimmed)) return null;

	const segments = trimmed.split(/[\\/]+/);
	if (
		segments.some(
			(segment) =>
				!segment ||
				segment === "." ||
				segment === ".." ||
				containsInvalidWindowsCharacter(segment) ||
				/[. ]$/.test(segment) ||
				WINDOWS_RESERVED_NAME_PATTERN.test(segment),
		)
	) {
		return null;
	}
	return segments.join("\\");
}

function containsInvalidWindowsCharacter(segment: string): boolean {
	return (
		WINDOWS_INVALID_CHARACTER_PATTERN.test(segment) ||
		[...segment].some((character) => character.charCodeAt(0) < 32)
	);
}

/** 絶対パスが保存ルート以下なら、ルート相対パスへ変換する。 */
export function relativeSavePath(basePath: string, targetPath: string): string | null {
	const normalizedBase = normalizeWindowsPath(basePath);
	const normalizedTarget = normalizeWindowsPath(targetPath);
	const baseKey = canonicalWindowsPath(normalizedBase);
	const targetKey = canonicalWindowsPath(normalizedTarget);
	if (!normalizedBase || !normalizedTarget) return null;
	if (baseKey === targetKey) return "";
	if (!targetKey.startsWith(`${baseKey}\\`)) return null;
	return normalizedTarget.slice(normalizedBase.length + 1);
}

/** SaveSuggestionの絶対パスと相対パスから、初期設定済みの保存ルートを復元する。 */
export function inferSaveRoot(path: string, relativePath: string): string | null {
	const normalizedPath = normalizeWindowsPath(path);
	const normalizedRelative = normalizeRelativeSavePath(relativePath);
	if (!normalizedPath || normalizedRelative === null) return null;
	if (!normalizedRelative) return normalizedPath;

	const suffix = `\\${normalizedRelative}`;
	return canonicalWindowsPath(normalizedPath).endsWith(canonicalWindowsPath(suffix))
		? normalizedPath.slice(0, -suffix.length)
		: null;
}
