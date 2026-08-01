import type { ApplicationRecoveryStatus } from "./library-maintenance";

export type ApplicationPrimaryState =
	| "checking"
	| "setup-required"
	| "configurable"
	| "checking-folders"
	| "preparing"
	| "ready"
	| "rebuild-required"
	| "action-required";

export interface ApplicationStatePresentation {
	state: ApplicationPrimaryState;
	title: string;
	impact: string;
	action: "restore" | "rebuild" | "change-root" | null;
}

export interface ApplicationRecoveryDetails {
	settings: string;
	information: string;
}

export function presentApplicationRecoveryDetails(
	status: ApplicationRecoveryStatus,
): ApplicationRecoveryDetails {
	return {
		settings:
			status.database.state === "ready"
				? "設定と履歴を読み込めます。"
				: "設定と履歴を読み込めません。バックアップから復元するか、新しく開始してください。",
		information:
			status.searchIndex.state === "ready"
				? "資料の検索と整理を利用できます。"
				: "資料情報を作り直すと、検索と整理を利用できます。",
	};
}

export function deriveApplicationState(
	status: ApplicationRecoveryStatus | null,
	setupDone: boolean,
): ApplicationStatePresentation {
	if (!status) {
		return {
			state: "checking",
			title: "状態を確認中",
			impact: "Fuzzyを利用できるか確認しています。",
			action: null,
		};
	}
	if (status.database.state !== "ready") {
		return {
			state: "action-required",
			title: "利用者の操作が必要",
			impact: "設定や履歴を読み込めません。バックアップがあれば復元できます。",
			action: "restore",
		};
	}
	if (status.searchIndex.state !== "ready") {
		return {
			state: "rebuild-required",
			title: "情報の作り直しが必要",
			impact: "保存済み資料はそのままですが、検索と整理状況は準備が終わるまで利用できません。",
			action: "rebuild",
		};
	}
	if (!setupDone) {
		return {
			state: "setup-required",
			title: "初期設定が必要",
			impact: "保存先とフォルダーの作り方を設定すると利用できます。",
			action: null,
		};
	}
	return {
		state: "ready",
		title: "利用できます",
		impact: "保存先やフォルダーの作り方はいつでも変更できます。",
		action: null,
	};
}

const technicalTermPattern =
	/SQLite|データベース|\bDB\b|検索索引|派生検索索引|内部索引|native-host|Native Messaging|IndexedDB|ターミナル|コマンド|通信仕様|プロトコル|\{(?:year|term|course|assignment|section)\}/i;

export function userFacingOperationError(error: unknown, fallback: string): string {
	const message = error instanceof Error ? error.message : "";
	if (!message || technicalTermPattern.test(message)) return fallback;
	return message;
}
