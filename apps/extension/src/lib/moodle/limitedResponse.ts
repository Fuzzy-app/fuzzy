/** Content-Lengthの有無に依存せず、上限内のテキスト応答だけを読み込む。 */
export async function readLimitedResponseText(
	response: Response,
	maximumBytes: number,
): Promise<string | null> {
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > maximumBytes) return null;
	const reader = response.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;
			if (length + value.byteLength > maximumBytes) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
			length += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

/** MoodleのDOMとして解析できるHTML系Content-Typeかを判定する。 */
export function isHtmlResponse(response: Response): boolean {
	const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
	return /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/.test(contentType);
}
