import { describe, expect, test } from "bun:test";
import {
	type SetupRuntime,
	getSetupStatusClient,
	parsePatternCandidates,
	parseSetupStatus,
	pickBaseFolderClient,
	saveInitialSetupClient,
	scanExistingStructureClient,
} from "../apps/desktop/src/lib/setup/api";
import type { InitialSetupPayload } from "../apps/desktop/src/lib/setup/types";

function runtimeFor(responses: Record<string, unknown>): SetupRuntime {
	return {
		async invoke<T>(command: string): Promise<T> {
			return responses[command] as T;
		},
	};
}

describe("desktop setup API", () => {
	test("Tauri応答を検証して実データとして返す", async () => {
		const candidate = {
			id: "estimated-1",
			name: "科目 / 回次",
			description: "推定結果",
			folders: ["情報アーキテクチャ/第03回"],
			courseSegmentIndex: 0,
			matchScore: 90,
			reason: "一致",
			recommended: true,
		};
		const runtime = runtimeFor({
			pick_base_folder: "C:/Fuzzy",
			scan_existing_structure: [candidate],
			get_setup_status: { done: true, savedAt: "2026-07-25T00:00:00.000Z" },
			save_initial_setup: {
				ok: true,
				maintenance: {
					scannedFileCount: 1,
					registeredFileCount: 1,
					updatedFileCount: 0,
					indexedFileCount: 1,
					missingFileCount: 0,
					skippedFileCount: 0,
					warnings: [],
				},
			},
		});

		expect(await pickBaseFolderClient(runtime)).toBe("C:/Fuzzy");
		expect(await scanExistingStructureClient("C:/Fuzzy", runtime)).toEqual([candidate]);
		expect(await getSetupStatusClient(runtime)).toEqual({
			done: true,
			savedAt: "2026-07-25T00:00:00.000Z",
		});
		const payload = {
			path: "C:/Fuzzy",
			pattern: candidate,
			rule: {
				id: "course-assignment",
				name: "科目 / 課題",
				description: "標準",
				template: "{course}/{assignment}",
				preview: [],
			},
			courseOverrides: [],
		} satisfies InitialSetupPayload;
		expect(await saveInitialSetupClient(payload, runtime)).toEqual({
			ok: true,
			maintenance: {
				scannedFileCount: 1,
				registeredFileCount: 1,
				updatedFileCount: 0,
				indexedFileCount: 1,
				missingFileCount: 0,
				skippedFileCount: 0,
				warnings: [],
			},
		});
	});

	test("壊れた応答を受け入れない", () => {
		expect(parsePatternCandidates([{ id: "missing-fields" }])).toBeNull();
		expect(parseSetupStatus({ done: "yes" })).toBeNull();
	});
});
