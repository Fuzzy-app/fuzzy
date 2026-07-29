import { isTauriRuntime } from "./extension-install";
import { parseLibraryMaintenanceSummary } from "./library-maintenance";
import type { LibraryMaintenanceSummary } from "./library-maintenance";
import type { InitialSetupPayload, PatternCandidate, SetupStatus } from "./types";

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
		description: "年度単位でまとめつつ、各科目の中に課題フォルダを配置する構成です。",
		folders: ["2026", ...createPreviewCourseFolders("2026")],
		courseSegmentIndex: 1,
		fileNameTemplate: null,
		matchScore: 92,
		evaluatedCount: 12,
		reason: "年度フォルダと科目名フォルダの並びが最も多く見つかりました。",
		recommended: true,
		requiresConfirmation: false,
	},
	{
		id: "course-assignment",
		name: "科目 / 課題",
		description: "シンプルに科目ごとで分け、その下に課題を入れる構成です。",
		folders: createPreviewCourseFolders(),
		courseSegmentIndex: 0,
		fileNameTemplate: null,
		matchScore: 76,
		evaluatedCount: 12,
		reason: "年度がないフォルダも一部含まれていたため候補として残しています。",
		recommended: false,
		requiresConfirmation: false,
	},
	{
		id: "download-flat",
		name: "単一フォルダ保存",
		description: "ダウンロード先を固定し、課題名だけで管理する構成です。",
		folders: previewCourses.map(({ name, assignment }) => `${name}_${assignment}`),
		courseSegmentIndex: null,
		fileNameTemplate: null,
		matchScore: 41,
		evaluatedCount: 12,
		reason: "課題名のみのフォルダが少数存在しました。",
		recommended: false,
		requiresConfirmation: false,
	},
];

let previewSavedAt: string | null = null;

/**
 * `vite dev`で画面だけを確認する場合の明示的なプレビューアダプター。
 * Tauri本番では使用せず、完了状態をlocalStorageへ保存しない。
 */
export const previewSetupAdapter: SetupRuntime = {
	async invoke<T>(command: string): Promise<T> {
		switch (command) {
			case "pick_base_folder":
				return previewFolder as T;
			case "scan_existing_structure":
				return structuredClone(previewCandidates) as T;
			case "save_initial_setup":
				previewSavedAt = new Date().toISOString();
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

export async function scanExistingStructureClient(
	path: string,
	runtime?: SetupRuntime,
): Promise<PatternCandidate[]> {
	const setupRuntime = runtime ?? (await createSetupRuntime());
	try {
		const value = await setupRuntime.invoke<unknown>("scan_existing_structure", {
			path,
		});
		const candidates = parsePatternCandidates(value);
		if (!candidates) throw new Error("invalid response");
		return candidates;
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
