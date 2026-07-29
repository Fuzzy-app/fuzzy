import { describe, expect, test } from "bun:test";
import {
	deriveApplicationState,
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

	test("利用者が対処できるエラーはそのまま表示する", () => {
		expect(
			userFacingOperationError(
				new Error("保存先フォルダーを選び直してください。"),
				"もう一度お試しください。",
			),
		).toBe("保存先フォルダーを選び直してください。");
	});
});
