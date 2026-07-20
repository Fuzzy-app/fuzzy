import { describe, expect, test } from "bun:test";
import {
	createExtensionRuntimeReport,
	getOrCreateInstallationId,
	reportCurrentExtensionRuntime,
} from "../../apps/extension/src/lib/runtime/extensionRuntime";
import type { InstallationIdStorage } from "../../apps/extension/src/lib/runtime/extensionRuntime";

function createStorage(initial: Record<string, unknown> = {}) {
	const values = { ...initial };
	const storage: InstallationIdStorage = {
		get: async () => ({ ...values }),
		set: async (next) => Object.assign(values, next),
	};
	return { storage, values };
}

describe("extension runtime report", () => {
	test("インストールIDを初回だけ生成して再利用する", async () => {
		const { storage, values } = createStorage();
		let generated = 0;
		const createId = () => {
			generated += 1;
			return "550e8400-e29b-41d4-a716-446655440000";
		};

		expect(await getOrCreateInstallationId(storage, createId)).toBe(
			"550e8400-e29b-41d4-a716-446655440000",
		);
		expect(await getOrCreateInstallationId(storage, createId)).toBe(
			"550e8400-e29b-41d4-a716-446655440000",
		);
		expect(generated).toBe(1);
		expect(values).toEqual({
			"fuzzy.extension.installationId": "550e8400-e29b-41d4-a716-446655440000",
		});
	});

	test("報告内容にブラウザ名を含めず、バージョンと通信仕様を含める", () => {
		expect(createExtensionRuntimeReport("installation-1", "0.1.0")).toEqual({
			installationId: "installation-1",
			extensionVersion: "0.1.0",
			protocolVersion: 1,
		});
	});

	test("native-hostが保存した観測情報を返す", async () => {
		const { storage } = createStorage();
		const reports: unknown[] = [];
		const observation = {
			installationId: "550e8400-e29b-41d4-a716-446655440000",
			extensionVersion: "0.1.0",
			protocolVersion: 1,
			firstSeenAt: "2026-07-20T12:00:00.000Z",
			lastSeenAt: "2026-07-20T12:00:00.000Z",
		};

		await expect(
			reportCurrentExtensionRuntime({
				storage,
				extensionVersion: "0.1.0",
				createId: () => "550e8400-e29b-41d4-a716-446655440000",
				client: {
					reportExtensionRuntime: async (report) => {
						reports.push(report);
						return observation;
					},
				},
			}),
		).resolves.toEqual(observation);
		expect(reports).toEqual([
			{
				installationId: "550e8400-e29b-41d4-a716-446655440000",
				extensionVersion: "0.1.0",
				protocolVersion: 1,
			},
		]);
	});
});
