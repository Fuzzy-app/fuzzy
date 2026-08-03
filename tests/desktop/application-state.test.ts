import { describe, expect, test } from "bun:test";
import {
	deriveApplicationState,
	presentApplicationRecoveryDetails,
	userFacingOperationError,
} from "../../apps/desktop/src/lib/setup/application-state";

describe("desktopの利用者向け主状態", () => {
	test("複数の内部状態から主状態を常に1つ導出する", () => {
		expect(
			deriveApplicationState(
				{
					database: { state: "ready", message: "ready" },
					searchIndex: { state: "needsRebuild", message: "rebuild" },
				},
				true,
			),
		).toEqual({
			state: "rebuild-required",
			title: "情報の作り直しが必要",
			impact: "保存済み資料はそのままですが、検索と整理状況は準備が終わるまで利用できません。",
			action: "rebuild",
		});
	});

	test("設定を読み込めない状態を、情報再作成より優先する", () => {
		const presentation = deriveApplicationState(
			{
				database: { state: "recoveryRequired", message: "broken" },
				searchIndex: { state: "needsRebuild", message: "stale" },
			},
			true,
		);
		expect(presentation.state).toBe("action-required");
		expect(presentation.action).toBe("restore");
	});

	test("互換しない内部データは授業資料を残して初期化へ進める", () => {
		const presentation = deriveApplicationState(
			{
				database: { state: "recoveryRequired", message: "old" },
				searchIndex: { state: "recoveryRequired", message: "old" },
				dataResetRequired: true,
			},
			true,
		);
		expect(presentation.title).toBe("初期状態に戻す必要があります");
		expect(presentation.action).toBeNull();
		expect(presentation.impact).toContain("授業資料");
	});

	test("backendの技術用語を利用者向けエラーへ露出させない", () => {
		for (const message of [
			"SQLite DBと検索索引を開けません",
			"Native Messagingホストが見つかりません",
			"通信仕様のプロトコルが一致しません",
			"{course}を含めてください",
		]) {
			expect(userFacingOperationError(new Error(message), "もう一度お試しください。")).toBe(
				"もう一度お試しください。",
			);
		}
	});

	test("backendの状態メッセージを復旧画面へ直接表示しない", () => {
		const details = presentApplicationRecoveryDetails({
			database: {
				state: "recoveryRequired",
				message: "SQLite DBを開けません。ターミナルで確認してください。",
			},
			searchIndex: {
				state: "needsRebuild",
				message: "内部索引と検索索引を再構築してください。",
			},
		});

		expect(details).toEqual({
			settings: "設定と履歴を読み込めません。バックアップから復元するか、新しく開始してください。",
			information: "資料情報を作り直すと、検索と整理を利用できます。",
		});
		expect(`${details.settings}${details.information}`).not.toMatch(
			/SQLite|\bDB\b|検索索引|内部索引|ターミナル/,
		);
	});

	test("利用者が対処できるエラーはそのまま表示する", () => {
		expect(
			userFacingOperationError(
				new Error("保存先フォルダーを選び直してください。"),
				"もう一度お試しください。",
			),
		).toBe("保存先フォルダーを選び直してください。");
	});
});
