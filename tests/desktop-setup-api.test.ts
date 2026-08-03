import { describe, expect, test } from "bun:test";
import {
	type SetupRuntime,
	getSavedSetupConfigurationClient,
	getSetupStatusClient,
	parsePatternCandidates,
	parseSavedSetupConfiguration,
	parseScanExistingStructureResult,
	parseSetupStatus,
	pickBaseFolderClient,
	saveInitialSetupClient,
	saveSetupChangesClient,
	scanExistingStructureClient,
} from "../apps/desktop/src/lib/setup/api";
import type { InitialSetupPayload, PatternCandidate } from "../apps/desktop/src/lib/setup/types";

function runtimeFor(responses: Record<string, unknown>): SetupRuntime {
	return {
		async invoke<T>(command: string): Promise<T> {
			return responses[command] as T;
		},
	};
}

describe("desktop setup API", () => {
	test("Tauri応答を検証して実データとして返す", async () => {
		const candidate: PatternCandidate = {
			id: "estimated-1",
			name: "科目 / 回次",
			description: "推定結果",
			folders: ["情報アーキテクチャ/第03回"],
			directorySegments: [{ kind: "course" }, { kind: "section", format: "numbered" }],
			courseSegmentIndex: 0,
			fileNameTemplate: null,
			matchScore: 90,
			evaluatedCount: 1,
			reason: "一致",
			recommended: true,
			requiresConfirmation: false,
		};
		const runtime = runtimeFor({
			pick_base_folder: "C:/Fuzzy",
			scan_existing_structure: {
				candidates: [candidate],
				scannedFileCount: 1,
				warningCount: 0,
			},
			get_setup_status: { done: true, savedAt: "2026-07-25T00:00:00.000Z" },
			get_saved_setup_configuration: {
				revision: "setup-v0:test",
				savedAt: "2026-07-25T00:00:00.000Z",
				baseFolderPath: "C:/Fuzzy",
				pattern: { id: "estimated-1", courseSegmentIndex: 0 },
				rule: {
					id: "course-assignment",
					template: "{course}/{assignment}",
				},
				courseOverrides: [{ courseName: "データベース", enabled: true, mode: "override" }],
			},
			save_initial_setup: {
				ok: true,
				maintenance: {
					scannedFileCount: 1,
					registeredFileCount: 1,
					updatedFileCount: 0,
					indexedFileCount: 1,
					reusedFingerprintCount: 0,
					missingFileCount: 0,
					skippedFileCount: 0,
					warnings: [],
				},
			},
			save_setup_changes: {
				ok: true,
				rootChanged: false,
				rebasedFileCount: 0,
				maintenance: {
					scannedFileCount: 1,
					registeredFileCount: 0,
					updatedFileCount: 1,
					indexedFileCount: 0,
					reusedFingerprintCount: 1,
					missingFileCount: 0,
					skippedFileCount: 0,
					warnings: [],
				},
			},
		});

		expect(await pickBaseFolderClient(runtime)).toBe("C:/Fuzzy");
		expect(await scanExistingStructureClient("C:/Fuzzy", runtime)).toEqual({
			candidates: [candidate],
			scannedFileCount: 1,
			warningCount: 0,
		});
		expect(await getSetupStatusClient(runtime)).toEqual({
			done: true,
			savedAt: "2026-07-25T00:00:00.000Z",
		});
		expect(await getSavedSetupConfigurationClient(runtime)).toEqual({
			revision: "setup-v0:test",
			savedAt: "2026-07-25T00:00:00.000Z",
			baseFolderPath: "C:/Fuzzy",
			pattern: { id: "estimated-1", courseSegmentIndex: 0 },
			rule: {
				id: "course-assignment",
				template: "{course}/{assignment}",
			},
			courseOverrides: [{ courseName: "データベース", enabled: true, mode: "override" }],
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
				reusedFingerprintCount: 0,
				missingFileCount: 0,
				skippedFileCount: 0,
				warnings: [],
			},
		});
		expect(
			await saveSetupChangesClient({ ...payload, expectedRevision: "setup-v0:test" }, runtime),
		).toEqual({
			ok: true,
			rootChanged: false,
			rebasedFileCount: 0,
			maintenance: {
				scannedFileCount: 1,
				registeredFileCount: 0,
				updatedFileCount: 1,
				indexedFileCount: 0,
				reusedFingerprintCount: 1,
				missingFileCount: 0,
				skippedFileCount: 0,
				warnings: [],
			},
		});
	});

	test("壊れた応答を受け入れない", () => {
		expect(parsePatternCandidates([{ id: "missing-fields" }])).toBeNull();
		expect(parseScanExistingStructureResult({ candidates: [] })).toBeNull();
		expect(parseSetupStatus({ done: "yes" })).toBeNull();
		expect(
			parseSavedSetupConfiguration({
				revision: "setup-v0:test",
				savedAt: "not-a-date",
			}),
		).toBeNull();
	});

	test.each([
		["SETUP_CONFLICT", "最新の設定を読み直し"],
		["RULE_CONFLICT", "授業ごとの設定"],
		["INVALID_PATH", "保存先を利用できません"],
	])("再保存エラー %s に対応する次の操作を示す", async (code, message) => {
		const pattern: PatternCandidate = {
			id: "course-assignment",
			name: "科目 / 課題",
			description: "",
			folders: [],
			directorySegments: [{ kind: "course" }, { kind: "assignment" }],
			courseSegmentIndex: 0,
			fileNameTemplate: null,
			matchScore: 100,
			evaluatedCount: 0,
			reason: "",
			recommended: true,
			requiresConfirmation: false,
		};
		const runtime: SetupRuntime = {
			async invoke(): Promise<never> {
				throw code;
			},
		};

		await expect(
			saveSetupChangesClient(
				{
					expectedRevision: "setup-v0:test",
					path: "C:/Fuzzy",
					pattern,
					rule: {
						id: "course-assignment",
						name: "科目 / 課題",
						description: "",
						template: "{course}/{assignment}",
						preview: ["アプリ演習 / 課題"],
					},
					courseOverrides: [],
				},
				runtime,
			),
		).rejects.toThrow(message);
	});
});
