import type { MoodleFileMeta } from "@fuzzy/shared";

export const SUPPORTED_FILE_EXTENSIONS = [
	"pdf",
	"doc",
	"docx",
	"ppt",
	"pptx",
	"xls",
	"xlsx",
	"csv",
	"txt",
	"zip",
	"7z",
	"rar",
	"kmz",
	"kml",
	"gpx",
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"mp3",
	"wav",
	"m4a",
	"ogg",
	"mp4",
	"webm",
	"avi",
	"mov",
	"exe",
	"htm",
	"html",
] as const;

export type SupportedFileExtension = (typeof SUPPORTED_FILE_EXTENSIONS)[number];

const SUPPORTED_FILE_EXTENSION_SET = new Set<string>(SUPPORTED_FILE_EXTENSIONS);

export const MIME_TYPE_TO_EXTENSION: Readonly<Record<string, SupportedFileExtension>> = {
	"application/pdf": "pdf",
	"application/zip": "zip",
	"application/x-7z-compressed": "7z",
	"application/vnd.rar": "rar",
	"application/vnd.google-earth.kmz": "kmz",
	"application/vnd.google-earth.kml+xml": "kml",
	"application/gpx+xml": "gpx",
	"application/msword": "doc",
	"application/vnd.ms-excel": "xls",
	"application/vnd.ms-powerpoint": "ppt",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
	"text/csv": "csv",
	"text/plain": "txt",
	"text/html": "html",
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/gif": "gif",
	"image/webp": "webp",
	"audio/mpeg": "mp3",
	"audio/wav": "wav",
	"audio/x-wav": "wav",
	"audio/mp4": "m4a",
	"audio/ogg": "ogg",
	"video/mp4": "mp4",
	"video/webm": "webm",
	"video/x-msvideo": "avi",
	"video/quicktime": "mov",
	"application/vnd.microsoft.portable-executable": "exe",
};

const FILE_TYPE_LABEL_ALIASES: Readonly<Record<string, SupportedFileExtension>> = {
	pdf: "pdf",
	"pdf document": "pdf",
	pdf文書: "pdf",
	word: "docx",
	"microsoft word": "docx",
	"word document": "docx",
	word文書: "docx",
	ワード: "docx",
	文書: "docx",
	powerpoint: "pptx",
	"microsoft powerpoint": "pptx",
	"powerpoint presentation": "pptx",
	パワーポイント: "pptx",
	プレゼンテーション: "pptx",
	excel: "xlsx",
	"microsoft excel": "xlsx",
	"excel spreadsheet": "xlsx",
	エクセル: "xlsx",
	表計算: "xlsx",
	zip: "zip",
	音声: "mp3",
	audio: "mp3",
	動画: "mp4",
	video: "mp4",
	executable: "exe",
};

/** MIME、拡張子、Moodleの構造化ラベルを既知の拡張子へ正規化する。 */
export function normalizeFileTypeHint(value: string | null | undefined): string | null {
	const normalized = normalizeLabel(value);
	if (!normalized || normalized === "php") return null;

	const mimeType = normalized.split(";", 1)[0]?.trim() ?? "";
	const fromMimeType = MIME_TYPE_TO_EXTENSION[mimeType];
	if (fromMimeType) return fromMimeType;
	if (SUPPORTED_FILE_EXTENSION_SET.has(normalized)) return normalized;
	return FILE_TYPE_LABEL_ALIASES[normalized] ?? null;
}

/** ファイル名またはURL末尾から、対応済みの拡張子だけを返す。 */
export function fileExtensionFromName(value: string): string | null {
	const withoutFragment = value.split(/[?#]/, 1)[0] ?? "";
	const decoded = safeDecodeURIComponent(withoutFragment);
	const extension = decoded.match(/\.([a-z0-9]{1,10})$/i)?.[1]?.toLowerCase() ?? null;
	return extension && SUPPORTED_FILE_EXTENSION_SET.has(extension) ? extension : null;
}

export function hasSupportedFileExtension(value: string): boolean {
	return fileExtensionFromName(value) !== null;
}

/** Moodleの標準ファイルアイコンURLから種別を取得する。 */
export function fileTypeFromMoodleIconUrl(value: string | null | undefined): string | null {
	const iconName = value?.match(
		/\/(?:f|file)\/([a-z0-9]+)(?:-\d+)?(?:\.(?:svg|png|gif|webp))?(?:[/?#]|$)/i,
	)?.[1];
	return normalizeFileTypeHint(iconName);
}

/** Content-Dispositionのfilename / filename*から対応済み拡張子を取得する。 */
export function fileExtensionFromContentDisposition(value: string | null): string | null {
	if (!value) return null;
	const encodedFileName = value.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i)?.[1];
	const regularFileName = value.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
	const fileName = encodedFileName ?? regularFileName?.[1] ?? regularFileName?.[2] ?? "";
	return fileExtensionFromName(fileName.trim().replace(/^['"]|['"]$/g, ""));
}

export function fileType(file: MoodleFileMeta): string {
	return (
		normalizeFileTypeHint(file.mimeHint) ??
		fileExtensionFromName(file.title) ??
		fileExtensionFromName(file.url) ??
		"file"
	);
}

export function isZipFile(file: MoodleFileMeta): boolean {
	return fileType(file) === "zip";
}

export function fileTypeInfo(file: MoodleFileMeta): { kind: string; label: string } {
	const kind = fileType(file);
	if (kind === "pdf") return { kind, label: "PDF" };
	if (["doc", "docx"].includes(kind)) return { kind: "document", label: kind.toUpperCase() };
	if (["ppt", "pptx"].includes(kind)) return { kind: "presentation", label: kind.toUpperCase() };
	if (["xls", "xlsx", "csv"].includes(kind))
		return { kind: "spreadsheet", label: kind.toUpperCase() };
	if (kind === "zip") return { kind, label: "ZIP" };
	if (["png", "jpg", "jpeg", "gif", "webp"].includes(kind))
		return { kind: "image", label: kind.toUpperCase() };
	return { kind: "other", label: kind === "file" ? "FILE" : kind.toUpperCase() };
}

export function displayFileTitle(file: MoodleFileMeta, extensionLabel: string): string {
	const extension = fileExtensionFromName(file.title);
	if (!extension || extension.toUpperCase() !== extensionLabel) return file.title;
	return file.title.slice(0, -(extension.length + 1));
}

function normalizeLabel(value: string | null | undefined): string {
	return (value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function safeDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
