import { RULE_SEGMENT_KINDS, type StructuredRuleSegment } from "@fuzzy/shared";
import { isTauriRuntime } from "./extension-install";
import { parseLibraryMaintenanceSummary } from "./library-maintenance";
import type { LibraryMaintenanceSummary } from "./library-maintenance";
import type {
	InitialSetupPayload,
	PatternCandidate,
	SavedSetupConfiguration,
	ScanExistingStructureResult,
	SetupChangesPayload,
	SetupStatus,
} from "./types";

export type SetupRuntime = {
	invoke: <T>(command: string, args: Record<string, unknown>) => Promise<T>;
};

export class SetupApiError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SetupApiError";
	}
}

export type InitialSetupSaveResult = {
	ok: true;
	maintenance: LibraryMaintenanceSummary;
};

export type SetupChangesSaveResult = {
	ok: true;
	rootChanged: boolean;
	rebasedFileCount: number;
	maintenance: LibraryMaintenanceSummary;
};

const previewFolder = "C:/Users/preview/Documents/Fuzzy";
const previewCourses = [
	{ name: "情報アーキテクチャ", assignment: "第03回レポート" },
	{ name: "データベース", assignment: "正規化レポート" },
	{ name: "離散数学", assignment: "小テスト" },
	{ name: "アプリ演習", assignment: "第05回制作課題" },
	{ name: "認知科学概論", assignment: "期末レポート" },
	{ name: "英語IIB", assignment: "単語テスト" },
] as const;

function createPreviewCourseFolders(prefix?: string): string[] {
	return previewCourses.map(({ name, assignment }) =>
		[prefix, name, assignment].filter(Boolean).join("/"),
	);
}

const previewCandidates: PatternCandidate[] = [
	{
		id: "year-course-assignment",
		name: "年度 / 科目 / 課題",
		description: "年度単位でまとめつつ、各科目の中に課題フォルダーを配置する構成です。",
		folders: ["2026", ...createPreviewCourseFolders("2026")],
		directorySegments: [{ kind: "year" }, { kind: "course" }, { kind: "assignment" }],
		courseSegmentIndex: 1,
		fileNameTemplate: null,
		matchScore: 92,
		evaluatedCount: 12,
		reason: "年度フォルダーと科目名フォルダーの並びが最も多く見つかりました。",
		recommended: true,
		requiresConfirmation: false,
	},
	{
		id: "course-assignment",
		name: "科目 / 課題",
		description: "シンプルに科目ごとで分け、その下に課題を入れる構成です。",
		folders: createPreviewCourseFolders(),
		directorySegments: [{ kind: "course" }, { kind: "assignment" }],
		courseSegmentIndex: 0,
		fileNameTemplate: null,
		matchScore: 76,
		evaluatedCount: 12,
		reason: "年度がないフォルダーも一部含まれていたため候補として残しています。",
		recommended: false,
		requiresConfirmation: false,
	},
	{
		id: "download-flat",
		name: "単一フォルダー保存",
		description: "ダウンロード先を固定し、課題名だけで管理する構成です。",
		folders: previewCourses.map(({ name, assignment }) => `${name}_${assignment}`),
		directorySegments: null,
		courseSegmentIndex: null,
		fileNameTemplate: null,
		matchScore: 41,
		evaluatedCount: 12,
		reason: "課題名のみのフォルダーが少数存在しました。",
		recommended: false,
		requiresConfirmation: false,
	},
];

let previewSavedAt: string | null = null;
let previewConfiguration: SavedSetupConfiguration | null = null;

/**
 * `vite dev`で画面だけを確認する場合の明示的なプレビューアダプター。
 * Tauri本番では使用せず、完了状態をlocalStorageへ保存しない。
 */
export const previewSetupAdapter: SetupRuntime = {
	async invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
		switch (command) {
			case "pick_base_folder":
				return previewFolder as T;
			case "pick_course_folder":
				return `${previewFolder}/情報アーキテクチャ` as T;
			case "scan_existing_structure":
				return {
					candidates: structuredClone(previewCandidates),
					scannedFileCount: 12,
					warningCount: 0,
				} as T;
			case "save_initial_setup": {
				const payload = args as unknown as InitialSetupPayload;
				previewSavedAt = new Date().toISOString();
				previewConfiguration = {
					revision: `preview-${previewSavedAt}`,
					savedAt: previewSavedAt,
					baseFolderPath: payload.path,
					pattern: {
						id: payload.pattern.id,
						courseSegmentIndex: payload.pattern.courseSegmentIndex,
					},
					rule: {
						id: payload.rule.id,
						template: payload.rule.template,
						...(payload.rule.folderNameLanguage
							? { folderNameLanguage: payload.rule.folderNameLanguage }
							: {}),
					},
					courseOverrides: payload.courseOverrides.map(({ courseName, enabled, mode }) => ({
						courseName,
						enabled,
						mode,
					})),
				};
				return {
					ok: true,
					maintenance: {
						scannedFileCount: previewCandidates[0]?.folders.length ?? 0,
						registeredFileCount: 0,
						updatedFileCount: 0,
						indexedFileCount: 0,
						reusedFingerprintCount: 0,
						missingFileCount: 0,
						skippedFileCount: 0,
						warnings: [],
					},
				} as T;
			}
			case "get_saved_setup_configuration":
				return structuredClone(previewConfiguration) as T;
			case "save_setup_changes": {
				const payload = args as unknown as SetupChangesPayload;
				if (!previewConfiguration || payload.expectedRevision !== previewConfiguration.revision) {
					throw new SetupApiError("設定が更新されています。");
				}
				const previousPath = previewConfiguration.baseFolderPath;
				previewSavedAt = new Date().toISOString();
				previewConfiguration = {
					revision: `preview-${previewSavedAt}`,
					savedAt: previewSavedAt,
					baseFolderPath: payload.path,
					pattern: {
						id: payload.pattern.id,
						courseSegmentIndex: payload.pattern.courseSegmentIndex,
					},
					rule: {
						id: payload.rule.id,
						template: payload.rule.template,
						...(payload.rule.folderNameLanguage
							? { folderNameLanguage: payload.rule.folderNameLanguage }
							: {}),
					},
					courseOverrides: payload.courseOverrides.map(({ courseName, enabled, mode }) => ({
						courseName,
						enabled,
						mode,
					})),
				};
				return {
					ok: true,
					rootChanged: previousPath !== payload.path,
					rebasedFileCount: 0,
					maintenance: {
						scannedFileCount: previewCandidates[0]?.folders.length ?? 0,
						registeredFileCount: 0,
						updatedFileCount: 0,
						indexedFileCount: 0,
						reusedFingerprintCount: 0,
						missingFileCount: 0,
						skippedFileCount: 0,
						warnings: [],
					},
				} as T;
			}
			case "get_setup_status":
				return {
					done: previewSavedAt !== null,
					...(previewSavedAt ? { savedAt: previewSavedAt } : {}),
				} as T;
			default:
				throw new SetupApiError(`未対応のプレビューコマンドです: ${command}`);
		}
	},
};

async function createSetupRuntime(): Promise<SetupRuntime> {
	if (!isTauriRuntime()) return previewSetupAdapter;
	const { invoke } = await import("@tauri-apps/api/core");
	return { invoke };
}

export function parsePatternCandidates(value: unknown): PatternCandidate[] | null {
	if (!Array.isArray(value)) return null;
	const candidates: PatternCandidate[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") return null;
		const candidate = item as Record<string, unknown>;
		if (
			typeof candidate.id !== "string" ||
			!candidate.id ||
			typeof candidate.name !== "string" ||
			typeof candidate.description !== "string" ||
			!Array.isArray(candidate.folders) ||
			!candidate.folders.every((folder) => typeof folder === "string") ||
			!(
				candidate.directorySegments === null ||
				(Array.isArray(candidate.directorySegments) &&
					candidate.directorySegments.every((segment) => {
						if (!segment || typeof segment !== "object") return false;
						const value = segment as Record<string, unknown>;
						if (
							typeof value.kind !== "string" ||
							!RULE_SEGMENT_KINDS.includes(value.kind as (typeof RULE_SEGMENT_KINDS)[number])
						) {
							return false;
						}
						if (value.kind === "fixed") {
							if (typeof value.value !== "string" || value.value.length === 0) {
								return false;
							}
						} else if (value.value !== undefined) {
							return false;
						}
						return (
							value.format === undefined ||
							(value.kind === "section" && value.format === "numbered") ||
							(value.kind === "year" &&
								(value.format === "yearSuffix" || value.format === "academicYearSuffix"))
						);
					}))
			) ||
			!(
				candidate.courseSegmentIndex === null ||
				(typeof candidate.courseSegmentIndex === "number" &&
					Number.isInteger(candidate.courseSegmentIndex) &&
					candidate.courseSegmentIndex >= 0)
			) ||
			!(candidate.fileNameTemplate === null || typeof candidate.fileNameTemplate === "string") ||
			!(
				candidate.matchScore === null ||
				(typeof candidate.matchScore === "number" &&
					Number.isInteger(candidate.matchScore) &&
					candidate.matchScore >= 0 &&
					candidate.matchScore <= 100)
			) ||
			typeof candidate.evaluatedCount !== "number" ||
			!Number.isInteger(candidate.evaluatedCount) ||
			candidate.evaluatedCount < 0 ||
			typeof candidate.reason !== "string" ||
			typeof candidate.recommended !== "boolean" ||
			typeof candidate.requiresConfirmation !== "boolean"
		) {
			return null;
		}
		candidates.push({
			id: candidate.id,
			name: candidate.name,
			description: candidate.description,
			folders: candidate.folders,
			directorySegments: candidate.directorySegments as StructuredRuleSegment[] | null,
			courseSegmentIndex: candidate.courseSegmentIndex,
			fileNameTemplate: candidate.fileNameTemplate,
			matchScore: candidate.matchScore,
			evaluatedCount: candidate.evaluatedCount,
			reason: candidate.reason,
			recommended: candidate.recommended,
			requiresConfirmation: candidate.requiresConfirmation,
		});
	}
	return candidates;
}

export function parseScanExistingStructureResult(
	value: unknown,
): ScanExistingStructureResult | null {
	if (Array.isArray(value)) {
		const candidates = parsePatternCandidates(value);
		return candidates ? { candidates, scannedFileCount: 0, warningCount: 0 } : null;
	}
	if (!value || typeof value !== "object") return null;
	const result = value as Record<string, unknown>;
	const candidates = parsePatternCandidates(result.candidates);
	if (
		!candidates ||
		typeof result.scannedFileCount !== "number" ||
		!Number.isInteger(result.scannedFileCount) ||
		result.scannedFileCount < 0 ||
		typeof result.warningCount !== "number" ||
		!Number.isInteger(result.warningCount) ||
		result.warningCount < 0
	) {
		return null;
	}
	return {
		candidates,
		scannedFileCount: result.scannedFileCount,
		warningCount: result.warningCount,
	};
}

export function parseSetupStatus(value: unknown): SetupStatus | null {
	if (!value || typeof value !== "object") return null;
	const status = value as Record<string, unknown>;
	if (typeof status.done !== "boolean") return null;
	if (status.savedAt !== undefined) {
		if (typeof status.savedAt !== "string" || Number.isNaN(Date.parse(status.savedAt))) {
			return null;
		}
		return { done: status.done, savedAt: status.savedAt };
	}
	return { done: status.done };
}

export function parseSavedSetupConfiguration(value: unknown): SavedSetupConfiguration | null {
	if (!value || typeof value !== "object") return null;
	const configuration = value as Record<string, unknown>;
	const pattern =
		configuration.pattern && typeof configuration.pattern === "object"
			? (configuration.pattern as Record<string, unknown>)
			: null;
	const rule =
		configuration.rule && typeof configuration.rule === "object"
			? (configuration.rule as Record<string, unknown>)
			: null;
	if (
		typeof configuration.revision !== "string" ||
		configuration.revision.length === 0 ||
		typeof configuration.savedAt !== "string" ||
		Number.isNaN(Date.parse(configuration.savedAt)) ||
		typeof configuration.baseFolderPath !== "string" ||
		configuration.baseFolderPath.length === 0 ||
		!pattern ||
		typeof pattern.id !== "string" ||
		pattern.id.length === 0 ||
		!(
			pattern.courseSegmentIndex === null ||
			(typeof pattern.courseSegmentIndex === "number" &&
				Number.isInteger(pattern.courseSegmentIndex) &&
				pattern.courseSegmentIndex >= 0)
		) ||
		!rule ||
		typeof rule.id !== "string" ||
		rule.id.length === 0 ||
		typeof rule.template !== "string" ||
		rule.template.length === 0 ||
		(rule.folderNameLanguage !== undefined &&
			rule.folderNameLanguage !== "ja" &&
			rule.folderNameLanguage !== "en") ||
		!Array.isArray(configuration.courseOverrides)
	) {
		return null;
	}
	const courseOverrides: SavedSetupConfiguration["courseOverrides"] = [];
	const seenCourseNames = new Set<string>();
	for (const item of configuration.courseOverrides) {
		if (!item || typeof item !== "object") return null;
		const override = item as Record<string, unknown>;
		if (
			typeof override.courseName !== "string" ||
			override.courseName.trim().length === 0 ||
			(typeof override.enabled !== "boolean" && override.enabled !== undefined)
		) {
			return null;
		}
		const courseName = override.courseName.trim();
		if (seenCourseNames.has(courseName)) continue;
		seenCourseNames.add(courseName);
		const mode =
			override.mode === "common" || override.mode === "override" || override.mode === "unmanaged"
				? override.mode
				: override.enabled === true
					? "override"
					: "common";
		courseOverrides.push({
			courseName,
			enabled: override.enabled === true,
			mode,
		});
	}
	return {
		revision: configuration.revision,
		savedAt: configuration.savedAt,
		baseFolderPath: configuration.baseFolderPath,
		pattern: {
			id: pattern.id,
			courseSegmentIndex: pattern.courseSegmentIndex as number | null,
		},
		rule: {
			id: rule.id,
			template: rule.template,
			...(rule.folderNameLanguage ? { folderNameLanguage: rule.folderNameLanguage } : {}),
		},
		courseOverrides,
	};
}

export async function pickBaseFolderClient(runtime?: SetupRuntime): Promise<string | null> {
	const setupRuntime = runtime ?? (await createSetupRuntime());
	try {
		const value = await setupRuntime.invoke<unknown>("pick_base_folder", {});
		if (value === null || typeof value === "string") return value;
		throw new Error("invalid response");
	} catch {
		throw new SetupApiError(
			"保存先フォルダーを選択できませんでした。Fuzzyを再起動してから再試行してください。",
		);
	}
}

export async function pickCourseFolderClient(runtime?: SetupRuntime): Promise<string | null> {
	const setupRuntime = runtime ?? (await createSetupRuntime());
	try {
		const value = await setupRuntime.invoke<unknown>("pick_course_folder", {});
		if (value === null || typeof value === "string") return value;
		throw new Error("invalid response");
	} catch {
		throw new SetupApiError(
			"授業フォルダーを選択できませんでした。Fuzzyを再起動してから再試行してください。",
		);
	}
}

export async function scanExistingStructureClient(
	path: string,
	runtime?: SetupRuntime,
): Promise<ScanExistingStructureResult> {
	const setupRuntime = runtime ?? (await createSetupRuntime());
	try {
		const value = await setupRuntime.invoke<unknown>("scan_existing_structure", {
			path,
		});
		const result = parseScanExistingStructureResult(value);
		if (!result) throw new Error("invalid response");
		return result;
	} catch {
		throw new SetupApiError(
			"既存のフォルダー構成を読み取れませんでした。保存先のアクセス権を確認してください。",
		);
	}
}

export async function saveInitialSetupClient(
	payload: InitialSetupPayload,
	runtime?: SetupRuntime,
): Promise<InitialSetupSaveResult> {
	const setupRuntime = runtime ?? (await createSetupRuntime());
	try {
		const value = await setupRuntime.invoke<unknown>(
			"save_initial_setup",
			payload as unknown as Record<string, unknown>,
		);
		if (!value || typeof value !== "object") {
			throw new Error("invalid response");
		}
		const result = value as Record<string, unknown>;
		const maintenance = parseLibraryMaintenanceSummary(result.maintenance);
		if (result.ok !== true || !maintenance) throw new Error("invalid response");
		return { ok: true, maintenance };
	} catch {
		throw new SetupApiError(
			"初期設定を保存できませんでした。保存先とフォルダーの作り方を確認してください。",
		);
	}
}

export async function getSetupStatusClient(runtime?: SetupRuntime): Promise<SetupStatus> {
	const setupRuntime = runtime ?? (await createSetupRuntime());
	try {
		const value = await setupRuntime.invoke<unknown>("get_setup_status", {});
		const status = parseSetupStatus(value);
		if (!status) throw new Error("invalid response");
		return status;
	} catch {
		throw new SetupApiError("初期設定の状態を読み込めませんでした。Fuzzyを再起動してください。");
	}
}

export async function getSavedSetupConfigurationClient(
	runtime?: SetupRuntime,
): Promise<SavedSetupConfiguration> {
	const setupRuntime = runtime ?? (await createSetupRuntime());
	try {
		const value = await setupRuntime.invoke<unknown>("get_saved_setup_configuration", {});
		const configuration = parseSavedSetupConfiguration(value);
		if (!configuration) throw new Error("invalid response");
		return configuration;
	} catch {
		throw new SetupApiError(
			"保存済みの設定を読み込めませんでした。現在の設定は変更されていません。",
		);
	}
}

export async function saveSetupChangesClient(
	payload: SetupChangesPayload,
	runtime?: SetupRuntime,
): Promise<SetupChangesSaveResult> {
	const setupRuntime = runtime ?? (await createSetupRuntime());
	try {
		const value = await setupRuntime.invoke<unknown>(
			"save_setup_changes",
			payload as unknown as Record<string, unknown>,
		);
		if (!value || typeof value !== "object") throw new Error("invalid response");
		const result = value as Record<string, unknown>;
		const maintenance = parseLibraryMaintenanceSummary(result.maintenance);
		if (
			result.ok !== true ||
			typeof result.rootChanged !== "boolean" ||
			typeof result.rebasedFileCount !== "number" ||
			!Number.isInteger(result.rebasedFileCount) ||
			result.rebasedFileCount < 0 ||
			!maintenance
		) {
			throw new Error("invalid response");
		}
		return {
			ok: true,
			rootChanged: result.rootChanged,
			rebasedFileCount: result.rebasedFileCount,
			maintenance,
		};
	} catch (error) {
		const code = typeof error === "string" ? error : error instanceof Error ? error.message : "";
		if (code.includes("SETUP_CONFLICT")) {
			throw new SetupApiError(
				"保存済みの設定が別の画面で更新されました。最新の設定を読み直し、変更内容をもう一度確認してください。",
			);
		}
		if (code.includes("RULE_CONFLICT")) {
			throw new SetupApiError(
				"フォルダーの作り方が授業ごとの設定と合いません。整理ルールを見直してください。",
			);
		}
		if (code.includes("INVALID_PATH")) {
			throw new SetupApiError(
				"選択した保存先を利用できません。フォルダーの場所とアクセス権を確認してください。",
			);
		}
		throw new SetupApiError(
			"変更内容を保存できませんでした。入力内容を確認して再試行してください。",
		);
	}
}
