import { describe, expect, test } from "bun:test";
import type { ExtensionStatusRuntime } from "../../apps/desktop/src/lib/setup/extension-install";
import {
	changeLibraryRootClient,
	createFreshDatabaseClient,
	exportBackupClient,
	getApplicationRecoveryStatusClient,
	importBackupClient,
	parseApplicationRecoveryStatus,
	parseLibraryMaintenanceSummary,
	rebuildLibraryClient,
} from "../../apps/desktop/src/lib/setup/library-maintenance";

const summary = {
	scannedFileCount: 6,
	registeredFileCount: 2,
	updatedFileCount: 1,
	indexedFileCount: 5,
	reusedFingerprintCount: 0,
	missingFileCount: 0,
	skippedFileCount: 1,
	warnings: [{ path: "英語IIB/資料.pdf", message: "本文を抽出できませんでした。" }],
};

describe("desktop library maintenance client", () => {
	test("保守結果を厳密に検証する", () => {
		expect(parseLibraryMaintenanceSummary(summary)).toEqual(summary);
		expect(
			parseLibraryMaintenanceSummary({
				...summary,
				indexedFileCount: -1,
			}),
		).toBeNull();
		expect(
			parseLibraryMaintenanceSummary({
				...summary,
				warnings: [{ path: "資料.pdf", message: 1 }],
			}),
		).toBeNull();
	});

	test("起動時のSQLite・検索索引復旧状態を厳密に検証する", () => {
		const status = {
			database: {
				state: "recoveryRequired",
				message: "SQLite正本を開けませんでした。",
			},
			searchIndex: {
				state: "needsRebuild",
				message: "検索索引の再構築が必要です。",
			},
		} as const;

		expect(parseApplicationRecoveryStatus(status)).toEqual(status);
		expect(
			parseApplicationRecoveryStatus({
				...status,
				database: { state: "needsRebuild", message: "invalid" },
			}),
		).toBeNull();
		expect(
			parseApplicationRecoveryStatus({
				...status,
				searchIndex: { state: "unknown", message: "invalid" },
			}),
		).toBeNull();
		expect(
			parseApplicationRecoveryStatus({
				...status,
				dataResetRequired: true,
			}),
		).toEqual({ ...status, dataResetRequired: true });
		expect(
			parseApplicationRecoveryStatus({
				...status,
				dataResetRequired: "yes",
			}),
		).toBeNull();
	});

	test("再構築・書き出し・復元を専用Tauriコマンドへ配線する", async () => {
		const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
		const runtime: ExtensionStatusRuntime = {
			invoke: async <T>(command: string, args: Record<string, unknown>) => {
				calls.push({ command, args });
				if (command === "rebuild_library") return summary as T;
				if (command === "get_application_recovery_status") {
					return {
						database: { state: "ready", message: "SQLite正本を利用できます。" },
						searchIndex: { state: "ready", message: "検索索引を利用できます。" },
					} as T;
				}
				if (command === "create_fresh_database") {
					return {
						cancelled: false,
						created: true,
						recoveryCopyPath: "C:/Recovery/fuzzy.db",
					} as T;
				}
				if (command === "change_library_root") {
					return {
						cancelled: false,
						changed: true,
						rebasedFileCount: 4,
						maintenance: summary,
					} as T;
				}
				if (command === "export_backup") {
					return { cancelled: false, filePath: "D:/Backup/Fuzzy.sqlite3" } as T;
				}
				return {
					cancelled: false,
					imported: true,
					recoveryCopyPath: "C:/Recovery/fuzzy.db",
					maintenance: summary,
				} as T;
			},
		};

		await expect(rebuildLibraryClient(runtime)).resolves.toEqual(summary);
		await expect(getApplicationRecoveryStatusClient(runtime)).resolves.toMatchObject({
			database: { state: "ready" },
			searchIndex: { state: "ready" },
		});
		await expect(createFreshDatabaseClient(runtime)).resolves.toEqual({
			cancelled: false,
			created: true,
			recoveryCopyPath: "C:/Recovery/fuzzy.db",
		});
		await expect(changeLibraryRootClient(runtime)).resolves.toEqual({
			cancelled: false,
			changed: true,
			rebasedFileCount: 4,
			maintenance: summary,
		});
		await expect(exportBackupClient(runtime)).resolves.toEqual({
			cancelled: false,
			filePath: "D:/Backup/Fuzzy.sqlite3",
		});
		await expect(importBackupClient(runtime)).resolves.toEqual({
			cancelled: false,
			imported: true,
			recoveryCopyPath: "C:/Recovery/fuzzy.db",
			maintenance: summary,
		});
		expect(calls).toEqual([
			{ command: "rebuild_library", args: { rebuildIndex: true } },
			{ command: "get_application_recovery_status", args: {} },
			{ command: "create_fresh_database", args: {} },
			{ command: "change_library_root", args: {} },
			{ command: "export_backup", args: {} },
			{ command: "import_backup", args: {} },
		]);
	});

	test("保存先変更のキャンセルと変更後再構築失敗を区別する", async () => {
		const responses = [
			{ cancelled: true, changed: false, rebasedFileCount: 0 },
			{
				cancelled: false,
				changed: true,
				rebasedFileCount: 6,
				maintenanceError: "保存先は変更しましたが、索引を再構築できませんでした。",
			},
		];
		const runtime: ExtensionStatusRuntime = {
			invoke: async <T>() => responses.shift() as T,
		};

		await expect(changeLibraryRootClient(runtime)).resolves.toEqual({
			cancelled: true,
			changed: false,
			rebasedFileCount: 0,
		});
		await expect(changeLibraryRootClient(runtime)).resolves.toEqual({
			cancelled: false,
			changed: true,
			rebasedFileCount: 6,
			maintenanceError: "保存先は変更しましたが、索引を再構築できませんでした。",
		});
	});

	test("復元後の再構築失敗を復元失敗と混同しない", async () => {
		const runtime: ExtensionStatusRuntime = {
			invoke: async <T>() =>
				({
					cancelled: false,
					imported: true,
					recoveryCopyPath: "C:/Recovery/fuzzy.db",
					maintenanceError: "復元は完了しましたが、索引を再構築できませんでした。",
				}) as T,
		};

		await expect(importBackupClient(runtime)).resolves.toEqual({
			cancelled: false,
			imported: true,
			recoveryCopyPath: "C:/Recovery/fuzzy.db",
			maintenanceError: "復元は完了しましたが、索引を再構築できませんでした。",
		});
	});

	test("壊れたTauri応答を利用者向けエラーにする", async () => {
		const runtime: ExtensionStatusRuntime = {
			invoke: async <T>() => ({ ok: true }) as T,
		};

		await expect(rebuildLibraryClient(runtime)).rejects.toMatchObject({
			name: "LibraryMaintenanceError",
		});
		await expect(getApplicationRecoveryStatusClient(runtime)).rejects.toMatchObject({
			name: "LibraryMaintenanceError",
		});
		await expect(createFreshDatabaseClient(runtime)).rejects.toMatchObject({
			name: "LibraryMaintenanceError",
		});
		await expect(changeLibraryRootClient(runtime)).rejects.toMatchObject({
			name: "LibraryMaintenanceError",
		});
		await expect(exportBackupClient(runtime)).rejects.toMatchObject({
			name: "LibraryMaintenanceError",
		});
		await expect(importBackupClient(runtime)).rejects.toMatchObject({
			name: "LibraryMaintenanceError",
		});
	});
});
