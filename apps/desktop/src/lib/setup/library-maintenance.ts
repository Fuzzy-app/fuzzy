import { createStatusRuntime } from "./extension-install";
import type { ExtensionStatusRuntime } from "./extension-install";

export type LibraryMaintenanceWarning = {
	path: string;
	message: string;
};

export type LibraryMaintenanceSummary = {
	scannedFileCount: number;
	registeredFileCount: number;
	updatedFileCount: number;
	indexedFileCount: number;
	reusedFingerprintCount: number;
	missingFileCount: number;
	skippedFileCount: number;
	warnings: LibraryMaintenanceWarning[];
};

export type BackupExportResult = {
	cancelled: boolean;
	filePath?: string;
};

export type BackupImportResult = {
	cancelled: boolean;
	imported: boolean;
	recoveryCopyPath?: string;
	maintenance?: LibraryMaintenanceSummary;
	maintenanceError?: string;
};

export type RecoveryComponentStatus = {
	state: "ready" | "recoveryRequired" | "needsRebuild";
	message: string;
};

export type ApplicationRecoveryStatus = {
	database: RecoveryComponentStatus;
	searchIndex: RecoveryComponentStatus;
};

export type FreshDatabaseResult = {
	cancelled: boolean;
	created: boolean;
	recoveryCopyPath?: string;
	indexError?: string;
};

export type LibraryRootChangeResult = {
	cancelled: boolean;
	changed: boolean;
	rebasedFileCount: number;
	maintenance?: LibraryMaintenanceSummary;
	maintenanceError?: string;
};

export class LibraryMaintenanceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LibraryMaintenanceError";
	}
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseLibraryMaintenanceSummary(value: unknown): LibraryMaintenanceSummary | null {
	if (!value || typeof value !== "object") return null;
	const summary = value as Record<string, unknown>;
	if (
		!isCount(summary.scannedFileCount) ||
		!isCount(summary.registeredFileCount) ||
		!isCount(summary.updatedFileCount) ||
		!isCount(summary.indexedFileCount) ||
		!isCount(summary.reusedFingerprintCount) ||
		!isCount(summary.missingFileCount) ||
		!isCount(summary.skippedFileCount) ||
		!Array.isArray(summary.warnings) ||
		summary.warnings.length > 10_000
	) {
		return null;
	}
	const warnings: LibraryMaintenanceWarning[] = [];
	for (const item of summary.warnings) {
		if (!item || typeof item !== "object") return null;
		const warning = item as Record<string, unknown>;
		if (
			typeof warning.path !== "string" ||
			warning.path.length > 32_768 ||
			typeof warning.message !== "string" ||
			warning.message.length > 2_048
		) {
			return null;
		}
		warnings.push({ path: warning.path, message: warning.message });
	}
	return {
		scannedFileCount: summary.scannedFileCount,
		registeredFileCount: summary.registeredFileCount,
		updatedFileCount: summary.updatedFileCount,
		indexedFileCount: summary.indexedFileCount,
		reusedFingerprintCount: summary.reusedFingerprintCount,
		missingFileCount: summary.missingFileCount,
		skippedFileCount: summary.skippedFileCount,
		warnings,
	};
}

function parseBackupExportResult(value: unknown): BackupExportResult | null {
	if (!value || typeof value !== "object") return null;
	const result = value as Record<string, unknown>;
	if (typeof result.cancelled !== "boolean") return null;
	if (result.filePath !== undefined && typeof result.filePath !== "string") return null;
	return {
		cancelled: result.cancelled,
		...(typeof result.filePath === "string" ? { filePath: result.filePath } : {}),
	};
}

function parseBackupImportResult(value: unknown): BackupImportResult | null {
	if (!value || typeof value !== "object") return null;
	const result = value as Record<string, unknown>;
	if (
		typeof result.cancelled !== "boolean" ||
		typeof result.imported !== "boolean" ||
		(result.recoveryCopyPath !== undefined &&
			(typeof result.recoveryCopyPath !== "string" || result.recoveryCopyPath.length > 32_768)) ||
		(result.maintenanceError !== undefined &&
			(typeof result.maintenanceError !== "string" || result.maintenanceError.length > 4_096))
	) {
		return null;
	}
	if (result.cancelled) {
		return !result.imported &&
			result.maintenance === undefined &&
			result.maintenanceError === undefined &&
			result.recoveryCopyPath === undefined
			? { cancelled: true, imported: false }
			: null;
	}
	if (!result.imported) return null;
	const maintenance =
		result.maintenance === undefined
			? undefined
			: parseLibraryMaintenanceSummary(result.maintenance);
	if (
		(result.maintenance !== undefined && !maintenance) ||
		(maintenance === undefined) === (result.maintenanceError === undefined)
	) {
		return null;
	}
	return {
		cancelled: false,
		imported: true,
		...(typeof result.recoveryCopyPath === "string"
			? { recoveryCopyPath: result.recoveryCopyPath }
			: {}),
		...(maintenance ? { maintenance } : {}),
		...(typeof result.maintenanceError === "string"
			? { maintenanceError: result.maintenanceError }
			: {}),
	};
}

export function parseApplicationRecoveryStatus(value: unknown): ApplicationRecoveryStatus | null {
	if (!value || typeof value !== "object") return null;
	const result = value as Record<string, unknown>;
	const parseComponent = (
		component: unknown,
		allowedStates: RecoveryComponentStatus["state"][],
	): RecoveryComponentStatus | null => {
		if (!component || typeof component !== "object") return null;
		const status = component as Record<string, unknown>;
		if (
			typeof status.state !== "string" ||
			!allowedStates.includes(status.state as RecoveryComponentStatus["state"]) ||
			typeof status.message !== "string" ||
			status.message.length === 0 ||
			status.message.length > 4_096
		) {
			return null;
		}
		return {
			state: status.state as RecoveryComponentStatus["state"],
			message: status.message,
		};
	};
	const database = parseComponent(result.database, ["ready", "recoveryRequired"]);
	const searchIndex = parseComponent(result.searchIndex, [
		"ready",
		"recoveryRequired",
		"needsRebuild",
	]);
	return database && searchIndex ? { database, searchIndex } : null;
}

function parseFreshDatabaseResult(value: unknown): FreshDatabaseResult | null {
	if (!value || typeof value !== "object") return null;
	const result = value as Record<string, unknown>;
	if (
		typeof result.cancelled !== "boolean" ||
		typeof result.created !== "boolean" ||
		(result.recoveryCopyPath !== undefined &&
			(typeof result.recoveryCopyPath !== "string" || result.recoveryCopyPath.length > 32_768)) ||
		(result.indexError !== undefined &&
			(typeof result.indexError !== "string" || result.indexError.length > 4_096))
	) {
		return null;
	}
	if (result.cancelled) {
		return !result.created &&
			result.recoveryCopyPath === undefined &&
			result.indexError === undefined
			? { cancelled: true, created: false }
			: null;
	}
	if (!result.created || typeof result.recoveryCopyPath !== "string") return null;
	return {
		cancelled: false,
		created: true,
		recoveryCopyPath: result.recoveryCopyPath,
		...(typeof result.indexError === "string" ? { indexError: result.indexError } : {}),
	};
}

function parseLibraryRootChangeResult(value: unknown): LibraryRootChangeResult | null {
	if (!value || typeof value !== "object") return null;
	const result = value as Record<string, unknown>;
	if (
		typeof result.cancelled !== "boolean" ||
		typeof result.changed !== "boolean" ||
		!isCount(result.rebasedFileCount) ||
		(result.maintenanceError !== undefined &&
			(typeof result.maintenanceError !== "string" || result.maintenanceError.length > 4_096))
	) {
		return null;
	}
	if (result.cancelled) {
		return !result.changed &&
			result.rebasedFileCount === 0 &&
			result.maintenance === undefined &&
			result.maintenanceError === undefined
			? { cancelled: true, changed: false, rebasedFileCount: 0 }
			: null;
	}
	if (!result.changed) return null;
	const maintenance =
		result.maintenance === undefined
			? undefined
			: parseLibraryMaintenanceSummary(result.maintenance);
	if (
		(result.maintenance !== undefined && !maintenance) ||
		(maintenance === undefined) === (result.maintenanceError === undefined)
	) {
		return null;
	}
	return {
		cancelled: false,
		changed: true,
		rebasedFileCount: result.rebasedFileCount,
		...(maintenance ? { maintenance } : {}),
		...(typeof result.maintenanceError === "string"
			? { maintenanceError: result.maintenanceError }
			: {}),
	};
}

async function runtimeOrPreview(
	runtime?: ExtensionStatusRuntime | null,
): Promise<ExtensionStatusRuntime | null> {
	return runtime === undefined ? createStatusRuntime() : runtime;
}

export async function rebuildLibraryClient(
	runtime?: ExtensionStatusRuntime | null,
): Promise<LibraryMaintenanceSummary> {
	const commandRuntime = await runtimeOrPreview(runtime);
	if (!commandRuntime) {
		return {
			scannedFileCount: 0,
			registeredFileCount: 0,
			updatedFileCount: 0,
			indexedFileCount: 0,
			reusedFingerprintCount: 0,
			missingFileCount: 0,
			skippedFileCount: 0,
			warnings: [
				{
					path: ".",
					message: "ブラウザプレビューでは保存先の再スキャンを行いません。",
				},
			],
		};
	}
	try {
		const value = await commandRuntime.invoke<unknown>("rebuild_library", {
			rebuildIndex: true,
		});
		const summary = parseLibraryMaintenanceSummary(value);
		if (!summary) throw new Error("invalid response");
		return summary;
	} catch {
		throw new LibraryMaintenanceError(
			"保存先の再スキャンと検索索引の再構築に失敗しました。資料の保存完了後にブラウザを閉じ、再試行してください。",
		);
	}
}

export async function getApplicationRecoveryStatusClient(
	runtime?: ExtensionStatusRuntime | null,
): Promise<ApplicationRecoveryStatus> {
	const commandRuntime = await runtimeOrPreview(runtime);
	if (!commandRuntime) {
		return {
			database: {
				state: "ready",
				message: "ブラウザプレビューではSQLite復旧状態を確認しません。",
			},
			searchIndex: {
				state: "ready",
				message: "ブラウザプレビューでは検索索引を使用しません。",
			},
		};
	}
	try {
		const value = await commandRuntime.invoke<unknown>("get_application_recovery_status", {});
		const result = parseApplicationRecoveryStatus(value);
		if (!result) throw new Error("invalid response");
		return result;
	} catch {
		throw new LibraryMaintenanceError(
			"ローカルデータの状態を確認できませんでした。Fuzzyを再起動してください。",
		);
	}
}

export async function createFreshDatabaseClient(
	runtime?: ExtensionStatusRuntime | null,
): Promise<FreshDatabaseResult> {
	const commandRuntime = await runtimeOrPreview(runtime);
	if (!commandRuntime) return { cancelled: true, created: false };
	try {
		const value = await commandRuntime.invoke<unknown>("create_fresh_database", {});
		const result = parseFreshDatabaseResult(value);
		if (!result) throw new Error("invalid response");
		return result;
	} catch {
		throw new LibraryMaintenanceError(
			"破損DBを保全して新しいデータベースを作成できませんでした。Fuzzyを終了せず、時間をおいて再試行してください。",
		);
	}
}

export async function changeLibraryRootClient(
	runtime?: ExtensionStatusRuntime | null,
): Promise<LibraryRootChangeResult> {
	const commandRuntime = await runtimeOrPreview(runtime);
	if (!commandRuntime) {
		return { cancelled: true, changed: false, rebasedFileCount: 0 };
	}
	try {
		const value = await commandRuntime.invoke<unknown>("change_library_root", {});
		const result = parseLibraryRootChangeResult(value);
		if (!result) throw new Error("invalid response");
		return result;
	} catch {
		throw new LibraryMaintenanceError(
			"保存先を変更できませんでした。読み書きできるフォルダーを選んでください。",
		);
	}
}

export async function exportBackupClient(
	runtime?: ExtensionStatusRuntime | null,
): Promise<BackupExportResult> {
	const commandRuntime = await runtimeOrPreview(runtime);
	if (!commandRuntime) return { cancelled: true };
	try {
		const value = await commandRuntime.invoke<unknown>("export_backup", {});
		const result = parseBackupExportResult(value);
		if (!result) throw new Error("invalid response");
		return result;
	} catch {
		throw new LibraryMaintenanceError(
			"バックアップを書き出せませんでした。既存ファイルを上書きしない保存先を選んでください。",
		);
	}
}

export async function importBackupClient(
	runtime?: ExtensionStatusRuntime | null,
): Promise<BackupImportResult> {
	const commandRuntime = await runtimeOrPreview(runtime);
	if (!commandRuntime) return { cancelled: true, imported: false };
	try {
		const value = await commandRuntime.invoke<unknown>("import_backup", {});
		const result = parseBackupImportResult(value);
		if (!result) throw new Error("invalid response");
		return result;
	} catch {
		throw new LibraryMaintenanceError(
			"バックアップから復元できませんでした。Fuzzyが書き出したSQLiteファイルか確認してください。",
		);
	}
}
