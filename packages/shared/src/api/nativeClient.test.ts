import { afterEach, describe, expect, test } from "bun:test";
import { FILE_TRANSFER_LIMITS } from "../protocolLimits";
import { NativeApiClient } from "./nativeClient";

const originalChrome = (globalThis as { chrome?: unknown }).chrome;

function base64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

afterEach(() => {
	(globalThis as { chrome?: unknown }).chrome = originalChrome;
});

describe("NativeApiClientの接続ライフサイクル", () => {
	test("通常コマンドは同じ接続を再利用し、明示終了時に切断する", async () => {
		const messageListeners = new Set<(message: unknown) => void>();
		let connectCount = 0;
		let disconnectCount = 0;
		const port = {
			onMessage: {
				addListener(listener: (message: unknown) => void) {
					messageListeners.add(listener);
				},
			},
			onDisconnect: {
				addListener() {},
			},
			postMessage(message: { id: string; command: string }) {
				queueMicrotask(() => {
					const data =
						message.command === "search"
							? []
							: {
									courses: [],
									totalFiles: 0,
									totalViolations: 0,
									upcomingDeadlineCount: 0,
								};
					for (const listener of messageListeners) {
						listener({ id: message.id, ok: true, data });
					}
				});
			},
			disconnect() {
				disconnectCount += 1;
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

		const client = new NativeApiClient();
		await client.search("正規化");
		await client.getDashboard();

		expect(connectCount).toBe(1);
		expect(disconnectCount).toBe(0);
		client.disconnect();
		expect(disconnectCount).toBe(1);
	});

	test("分割された大規模応答を元のenvelopeへ安全に再構築する", async () => {
		const listeners = new Set<(message: unknown) => void>();
		const dashboard = {
			courses: [],
			totalFiles: 40_000,
			totalViolations: 1_234,
			upcomingDeadlineCount: 567,
		};
		(globalThis as { chrome?: unknown }).chrome = {
			runtime: {
				connectNative() {
					return {
						onMessage: {
							addListener(listener: (message: unknown) => void) {
								listeners.add(listener);
							},
						},
						onDisconnect: { addListener() {} },
						postMessage(message: { id: string }) {
							const encoded = new TextEncoder().encode(
								JSON.stringify({ id: message.id, ok: true, data: dashboard }),
							);
							const split = Math.floor(encoded.length / 2);
							const chunks = [encoded.slice(0, split), encoded.slice(split)];
							queueMicrotask(() => {
								for (const [index, bytes] of chunks.entries()) {
									for (const listener of listeners) {
										listener({
											id: message.id,
											ok: true,
											chunk: {
												index,
												total: chunks.length,
												encoding: "base64",
												data: base64(bytes),
											},
										});
									}
								}
							});
						},
						disconnect() {},
					};
				},
			},
		};

		const client = new NativeApiClient();
		expect(await client.getDashboard()).toEqual(dashboard);
	});

	test("分割応答の途中で通常応答へ切り替わった場合は拒否する", async () => {
		const listeners = new Set<(message: unknown) => void>();
		(globalThis as { chrome?: unknown }).chrome = {
			runtime: {
				connectNative() {
					return {
						onMessage: {
							addListener(listener: (message: unknown) => void) {
								listeners.add(listener);
							},
						},
						onDisconnect: { addListener() {} },
						postMessage(message: { id: string }) {
							queueMicrotask(() => {
								for (const listener of listeners) {
									listener({
										id: message.id,
										ok: true,
										chunk: {
											index: 0,
											total: 2,
											encoding: "base64",
											data: base64(new TextEncoder().encode('{"id":')),
										},
									});
									listener({
										id: message.id,
										ok: true,
										data: {
											courses: [],
											totalFiles: 0,
											totalViolations: 0,
											upcomingDeadlineCount: 0,
										},
									});
								}
							});
						},
						disconnect() {},
					};
				},
			},
		};

		await expect(new NativeApiClient().getDashboard()).rejects.toMatchObject({
			code: "INVALID_RESPONSE",
		});
	});

	test("pingは現在の通信仕様バージョンと一致するhostだけを受理する", async () => {
		let protocolVersion = 2;
		const createPort = () => {
			const listeners = new Set<(message: unknown) => void>();
			return {
				onMessage: {
					addListener(listener: (message: unknown) => void) {
						listeners.add(listener);
					},
				},
				onDisconnect: {
					addListener() {},
				},
				postMessage(message: { id: string }) {
					queueMicrotask(() => {
						for (const listener of listeners) {
							listener({
								id: message.id,
								ok: true,
								data: { version: "0.1.0", protocolVersion },
							});
						}
					});
				},
				disconnect() {},
			};
		};
		(globalThis as { chrome?: unknown }).chrome = {
			runtime: { connectNative: createPort },
		};

		const oldClient = new NativeApiClient();
		expect(await oldClient.ping()).toBe(false);
		oldClient.disconnect();

		protocolVersion = 6;
		const currentClient = new NativeApiClient();
		expect(await currentClient.ping()).toBe(true);
		currentClient.disconnect();
	});

	test("応答タイムアウト時は接続を閉じ、次回要求で再接続する", async () => {
		let connectCount = 0;
		let disconnectCount = 0;
		(globalThis as { chrome?: unknown }).chrome = {
			runtime: {
				connectNative() {
					connectCount += 1;
					return {
						onMessage: { addListener() {} },
						onDisconnect: { addListener() {} },
						postMessage() {},
						disconnect() {
							disconnectCount += 1;
						},
					};
				},
			},
		};
		const client = new NativeApiClient({ requestTimeoutMs: 5 });

		await expect(client.getDashboard()).rejects.toMatchObject({ code: "TIMEOUT" });
		await expect(client.getDashboard()).rejects.toMatchObject({ code: "TIMEOUT" });
		expect(connectCount).toBe(2);
		expect(disconnectCount).toBe(2);
	});

	test("ライブラリ再構築は通常要求と分離した長時間timeoutで完了を待つ", async () => {
		const messageListeners = new Set<(message: unknown) => void>();
		let disconnectCount = 0;
		(globalThis as { chrome?: unknown }).chrome = {
			runtime: {
				connectNative() {
					return {
						onMessage: {
							addListener(listener: (message: unknown) => void) {
								messageListeners.add(listener);
							},
							removeListener(listener: (message: unknown) => void) {
								messageListeners.delete(listener);
							},
						},
						onDisconnect: { addListener() {} },
						postMessage(message: { id: string; command: string }) {
							setTimeout(() => {
								for (const listener of messageListeners) {
									listener({
										id: message.id,
										ok: true,
										data: {
											scannedFileCount: 1,
											registeredFileCount: 1,
											updatedFileCount: 0,
											indexedFileCount: 1,
											reusedFingerprintCount: 0,
											missingFileCount: 0,
											skippedFileCount: 0,
											warnings: [],
										},
									});
								}
							}, 20);
						},
						disconnect() {
							disconnectCount += 1;
						},
					};
				},
			},
		};
		const client = new NativeApiClient({
			requestTimeoutMs: 1,
			libraryMaintenanceTimeoutMs: 100,
		});

		const summary = await client.rebuildLibrary({ rebuildIndex: true });

		expect(summary.indexedFileCount).toBe(1);
		expect(disconnectCount).toBe(1);
	});

	test("長時間処理でも分割応答の途中で通常応答へ切り替わった場合は拒否する", async () => {
		const listeners = new Set<(message: unknown) => void>();
		(globalThis as { chrome?: unknown }).chrome = {
			runtime: {
				connectNative() {
					return {
						onMessage: {
							addListener(listener: (message: unknown) => void) {
								listeners.add(listener);
							},
							removeListener(listener: (message: unknown) => void) {
								listeners.delete(listener);
							},
						},
						onDisconnect: { addListener() {} },
						postMessage(message: { id: string }) {
							queueMicrotask(() => {
								for (const listener of [...listeners]) {
									listener({
										id: message.id,
										ok: true,
										chunk: {
											index: 0,
											total: 2,
											encoding: "base64",
											data: base64(new TextEncoder().encode('{"id":')),
										},
									});
									listener({
										id: message.id,
										ok: true,
										data: {
											scannedFileCount: 0,
											registeredFileCount: 0,
											updatedFileCount: 0,
											indexedFileCount: 0,
											reusedFingerprintCount: 0,
											missingFileCount: 0,
											skippedFileCount: 0,
											warnings: [],
										},
									});
								}
							});
						},
						disconnect() {},
					};
				},
			},
		};

		await expect(
			new NativeApiClient().rebuildLibrary({ rebuildIndex: true }),
		).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
	});

	test("ZIP展開は通常要求と分離した長時間timeoutで完了を待つ", async () => {
		const messageListeners = new Set<(message: unknown) => void>();
		let disconnectCount = 0;
		(globalThis as { chrome?: unknown }).chrome = {
			runtime: {
				connectNative() {
					return {
						onMessage: {
							addListener(listener: (message: unknown) => void) {
								messageListeners.add(listener);
							},
							removeListener(listener: (message: unknown) => void) {
								messageListeners.delete(listener);
							},
						},
						onDisconnect: { addListener() {} },
						postMessage(message: { id: string }) {
							setTimeout(() => {
								for (const listener of messageListeners) {
									listener({
										id: message.id,
										ok: true,
										data: { extractedPaths: ["C:\\save\\guide.txt"] },
									});
								}
							}, 20);
						},
						disconnect() {
							disconnectCount += 1;
						},
					};
				},
			},
		};
		const client = new NativeApiClient({
			requestTimeoutMs: 1,
			zipExtractionTimeoutMs: 100,
		});

		const result = await client.extractZip({
			fileMeta: {
				title: "guide.zip",
				url: "https://moodle.example/guide.zip",
				moodleFileId: "zip-1",
				sectionTitle: null,
				mimeHint: "application/zip",
			},
			targetPath: "C:\\save",
			destinationPath: "C:\\save",
			flatten: true,
		});

		expect(result.extractedPaths).toEqual(["C:\\save\\guide.txt"]);
		expect(disconnectCount).toBe(1);
	});

	test("long-running session cleans up when postMessage throws synchronously", async () => {
		let disconnectCount = 0;
		let removeListenerCount = 0;
		(globalThis as { chrome?: unknown }).chrome = {
			runtime: {
				connectNative() {
					return {
						onMessage: {
							addListener() {},
							removeListener() {
								removeListenerCount += 1;
							},
						},
						onDisconnect: { addListener() {} },
						postMessage() {
							throw new Error("port closed");
						},
						disconnect() {
							disconnectCount += 1;
						},
					};
				},
			},
		};

		await expect(
			new NativeApiClient().rebuildLibrary({ rebuildIndex: true }),
		).rejects.toMatchObject({ code: "NO_NATIVE_HOST" });
		expect(removeListenerCount).toBe(1);
		expect(disconnectCount).toBe(1);
	});

	test("long-running session normalizes a synchronous connect failure", async () => {
		(globalThis as { chrome?: unknown }).chrome = {
			runtime: {
				connectNative() {
					throw new Error("host unavailable");
				},
			},
		};

		await expect(
			new NativeApiClient().rebuildLibrary({ rebuildIndex: true }),
		).rejects.toMatchObject({ code: "NO_NATIVE_HOST" });
	});

	test("long-running session keeps a successful result when disconnect already failed", async () => {
		const listeners = new Set<(message: unknown) => void>();
		(globalThis as { chrome?: unknown }).chrome = {
			runtime: {
				connectNative() {
					return {
						onMessage: {
							addListener(listener: (message: unknown) => void) {
								listeners.add(listener);
							},
							removeListener(listener: (message: unknown) => void) {
								listeners.delete(listener);
							},
						},
						onDisconnect: { addListener() {} },
						postMessage(message: { id: string }) {
							queueMicrotask(() => {
								for (const listener of listeners) {
									listener({
										id: message.id,
										ok: true,
										data: {
											scannedFileCount: 0,
											registeredFileCount: 0,
											updatedFileCount: 0,
											indexedFileCount: 0,
											reusedFingerprintCount: 0,
											missingFileCount: 0,
											skippedFileCount: 0,
											warnings: [],
										},
									});
								}
							});
						},
						disconnect() {
							throw new Error("already disconnected");
						},
					};
				},
			},
		};

		const result = await new NativeApiClient().rebuildLibrary({ rebuildIndex: true });
		expect(result.scannedFileCount).toBe(0);
	});
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
