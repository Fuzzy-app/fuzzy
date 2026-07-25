import { afterEach, describe, expect, test } from "bun:test";
import { FILE_TRANSFER_LIMITS } from "../protocolLimits";
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
			courseId: 2,
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

	test("rejects an oversized aggregate transfer before opening the native connection", async () => {
		let connectCount = 0;
		(globalThis as { chrome?: unknown }).chrome = {
			runtime: {
				connectNative() {
					connectCount += 1;
					throw new Error("must not connect");
				},
			},
		};

		const files = Array.from({ length: 3 }, (_, index) => ({
			fileId: `file-${index}`,
			fileName: `file-${index}.pdf`,
			mimeType: "application/pdf",
			byteLength: FILE_TRANSFER_LIMITS.maxFileBytes,
			contentBase64: "AA==",
		}));

		await expect(
			new NativeApiClient().saveFiles({
				targetPath: "C:\\save",
				courseId: 2,
				files,
			}),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		expect(connectCount).toBe(0);
	});

	test("類似照合用の内容も1接続内で分割転送する", async () => {
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
						message.command === "checkSimilarFiles"
							? [{ fileId: 1, originalName: "guide.pdf", similarity: 0.9 }]
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

		const result = await new NativeApiClient().checkSimilarFiles({
			fileMeta: {
				title: "guide.pdf",
				url: "https://moodle.example/guide.pdf",
				moodleFileId: "file-1",
				sectionTitle: null,
				mimeHint: "pdf",
			},
			contentBase64: "A".repeat(200_000),
		});

		expect(connectCount).toBe(1);
		expect(messages.map((message) => message.command)).toEqual([
			"beginCheckSimilarFile",
			"appendCheckSimilarFileChunk",
			"appendCheckSimilarFileChunk",
			"checkSimilarFiles",
		]);
		expect(messages[0]?.payload.byteLength).toBe(150_000);
		expect(messages.at(-1)?.payload).not.toHaveProperty("contentBase64");
		expect(
			messages
				.filter((message) => message.command === "appendCheckSimilarFileChunk")
				.every((message) => String(message.payload.dataBase64).length <= 192 * 1024),
		).toBe(true);
		expect(result[0]?.fileId).toBe(1);
		expect(disconnected).toBe(true);
	});

	test("類似照合チャンクが拒否された場合も接続を閉じる", async () => {
		const listeners = new Set<(message: unknown) => void>();
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
			postMessage(message: { id: string; command: string }) {
				queueMicrotask(() => {
					for (const listener of listeners) {
						listener(
							message.command === "appendCheckSimilarFileChunk"
								? {
										id: message.id,
										ok: false,
										error: { code: "INVALID_REQUEST", message: "invalid chunk" },
									}
								: { id: message.id, ok: true, data: { ok: true } },
						);
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
					return port;
				},
			},
		};

		await expect(
			new NativeApiClient().checkSimilarFiles({
				fileMeta: {
					title: "guide.pdf",
					url: "https://moodle.example/guide.pdf",
					moodleFileId: "file-1",
					sectionTitle: null,
					mimeHint: "pdf",
				},
				contentBase64: "dGVzdA==",
			}),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		expect(disconnected).toBe(true);
	});

	test("類似照合内容がない場合はnative-hostへ接続しない", async () => {
		let connectCount = 0;
		(globalThis as { chrome?: unknown }).chrome = {
			runtime: {
				connectNative() {
					connectCount += 1;
					throw new Error("must not connect");
				},
			},
		};

		await expect(
			new NativeApiClient().checkSimilarFiles({
				fileMeta: {
					title: "guide.pdf",
					url: "https://moodle.example/guide.pdf",
					moodleFileId: "file-1",
					sectionTitle: null,
					mimeHint: "pdf",
				},
			}),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		expect(connectCount).toBe(0);
	});
});
