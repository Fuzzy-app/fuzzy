import { afterEach, describe, expect, test } from "bun:test";
import type { LibraryMaintenanceSummary } from "../types";
import { MockApiClient } from "./mockClient";
import { NativeApiClient } from "./nativeClient";

const originalChrome = (globalThis as { chrome?: unknown }).chrome;

afterEach(() => {
	(globalThis as { chrome?: unknown }).chrome = originalChrome;
});

const summary: LibraryMaintenanceSummary = {
	scannedFileCount: 6,
	registeredFileCount: 2,
	updatedFileCount: 1,
	indexedFileCount: 5,
	reusedFingerprintCount: 0,
	missingFileCount: 0,
	skippedFileCount: 1,
	warnings: [{ path: "英語IIB\\資料.pdf", message: "本文を索引化できませんでした。" }],
};

describe("ライブラリ保守API", () => {
	test("Native MessagingへrebuildIndexを渡し、保守集計を返す", async () => {
		const messages: Array<{ id: string; command: string; payload: unknown }> = [];
		const listeners = new Set<(message: unknown) => void>();
		let disconnected = false;
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
						postMessage(message: (typeof messages)[number]) {
							messages.push(message);
							queueMicrotask(() => {
								for (const listener of listeners) {
									listener({ id: message.id, ok: true, data: summary });
								}
							});
						},
						disconnect() {
							disconnected = true;
						},
					};
				},
			},
		};

		const client = new NativeApiClient();
		await expect(client.rebuildLibrary({ rebuildIndex: true })).resolves.toEqual(summary);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			command: "rebuildLibrary",
			payload: { rebuildIndex: true },
		});
		await expect(
			client.reconcileCourseFiles({
				course: {
					moodleCourseId: "412",
					name: "データベース",
					academicYear: 2026,
					term: "前期",
				},
			}),
		).resolves.toEqual(summary);
		expect(messages[1]).toMatchObject({
			command: "reconcileCourseFiles",
			payload: { course: { moodleCourseId: "412", name: "データベース" } },
		});
		client.disconnect();
		expect(disconnected).toBe(true);
	});

	test("明示的な画面開発用Mockは保守処理を成功扱いにしない", async () => {
		await expect(new MockApiClient().rebuildLibrary({})).rejects.toMatchObject({
			code: "NO_NATIVE_HOST",
		});
		await expect(
			new MockApiClient().reconcileCourseFiles({
				course: {
					moodleCourseId: "412",
					name: "データベース",
					academicYear: null,
					term: null,
				},
			}),
		).rejects.toMatchObject({ code: "NO_NATIVE_HOST" });
	});
});
