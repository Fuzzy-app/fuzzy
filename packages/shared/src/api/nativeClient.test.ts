import { afterEach, describe, expect, test } from "bun:test";
import { NativeApiClient } from "./nativeClient";

const originalChrome = (globalThis as { chrome?: unknown }).chrome;

afterEach(() => {
	(globalThis as { chrome?: unknown }).chrome = originalChrome;
});

describe("NativeApiClientのファイル分割転送", () => {
	test("1接続内でbegin・複数chunk・saveFilesを順に送る", async () => {
		const messages: Array<{ id: string; command: string; payload: Record<string, unknown> }> = [];
		const listeners = new Set<(message: unknown) => void>();
		let connectCount = 0;
		let disconnected = false;
		const port = {
			onMessage: {
				addListener(listener: (message: unknown) => void) {
					listeners.add(listener);
				},
				removeListener(listener: (message: unknown) => void) {
					listeners.delete(listener);
				},
			},
			postMessage(message: (typeof messages)[number]) {
				messages.push(message);
				queueMicrotask(() => {
					const data =
						message.command === "saveFiles"
							? { savedFileIds: ["file-1"], failedFiles: [] }
							: { ok: true };
					for (const listener of listeners) {
						listener({ id: message.id, ok: true, data });
					}
				});
			},
			disconnect() {
				disconnected = true;
			},
		};
		(globalThis as { chrome?: unknown }).chrome = {
			runtime: {
				connectNative() {
					connectCount += 1;
					return port;
				},
			},
		};

		const result = await new NativeApiClient().saveFiles({
			targetPath: "C:\\save",
			files: [
				{
					fileId: "file-1",
					fileName: "guide.docx",
					mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
					byteLength: 150_000,
					contentBase64: "A".repeat(200_000),
				},
			],
		});

		expect(connectCount).toBe(1);
		expect(messages.map((message) => message.command)).toEqual([
			"beginSaveFiles",
			"appendSaveFileChunk",
			"appendSaveFileChunk",
			"saveFiles",
		]);
		expect(messages[0]?.payload).not.toHaveProperty("contentBase64");
		expect(
			messages
				.filter((message) => message.command === "appendSaveFileChunk")
				.every((message) => String(message.payload.dataBase64).length <= 192 * 1024),
		).toBe(true);
		expect(result.savedFileIds).toEqual(["file-1"]);
		expect(disconnected).toBe(true);
	});
});
