import { describe, expect, test } from "bun:test";
import type { FuzzyApiClient } from "@fuzzy/shared";
import { createRecoveringApiClientProvider } from "../../apps/extension/src/lib/api/recoveringClient";

describe("native-host再接続プロバイダー", () => {
	test("接続失敗をキャッシュせず、次の要求でnative接続を再試行する", async () => {
		let attempts = 0;
		const native = {
			mode: "native" as const,
			disconnect() {},
		} as unknown as FuzzyApiClient & { mode: "native"; disconnect(): void };
		const provider = createRecoveringApiClientProvider({
			createClient: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("native-host unavailable");
				return native;
			},
		});

		await expect(provider.getClient()).rejects.toThrow("native-host unavailable");
		expect(attempts).toBe(1);
		expect((await provider.getClient()).mode).toBe("native");
		expect(attempts).toBe(2);
	});

	test("disposeで保持中のnative接続を明示的に終了する", async () => {
		let disconnected = 0;
		const client = {
			mode: "native" as const,
			disconnect() {
				disconnected += 1;
			},
		} as unknown as FuzzyApiClient & { mode: "native"; disconnect(): void };
		const provider = createRecoveringApiClientProvider({
			createClient: async () => client,
		});

		await provider.getClient();
		provider.dispose();
		await Promise.resolve();
		expect(disconnected).toBe(1);
		expect(provider.mode).toBeNull();
	});
});
