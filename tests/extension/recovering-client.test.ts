import { describe, expect, test } from "bun:test";
import { MockApiClient } from "@fuzzy/shared";
import { createRecoveringApiClientProvider } from "../../apps/extension/src/lib/api/recoveringClient";

describe("native-host再接続プロバイダー", () => {
	test("mockを一定時間だけ共有し、期限後はnative接続を再試行する", async () => {
		let now = 1_000;
		let attempts = 0;
		const native = {
			mode: "native" as const,
			disconnect() {},
		} as unknown as MockApiClient & { mode: "native"; disconnect(): void };
		const provider = createRecoveringApiClientProvider({
			now: () => now,
			mockRetryMs: 5_000,
			createClient: async () => {
				attempts += 1;
				return attempts === 1 ? new MockApiClient() : native;
			},
		});

		expect((await provider.getClient()).mode).toBe("mock");
		expect((await provider.getClient()).mode).toBe("mock");
		expect(attempts).toBe(1);

		now += 5_001;
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
		} as unknown as MockApiClient & { mode: "native"; disconnect(): void };
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
