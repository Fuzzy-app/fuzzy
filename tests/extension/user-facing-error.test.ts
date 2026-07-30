import { describe, expect, test } from "bun:test";
import { userFacingErrorMessage } from "../../apps/extension/src/entrypoints/content/userFacingError";

describe("extensionの利用者向けエラー", () => {
	test.each([
		"SQLite DBを開けません",
		"Native Messagingホストがありません",
		"background service workerへの接続に失敗しました",
		"{course}を含めてください",
		"通信仕様のプロトコルが一致しません",
	])("技術詳細 %s を次の操作が分かる文へ置き換える", (message) => {
		expect(
			userFacingErrorMessage(new Error(message), "接続を確認して、もう一度お試しください。"),
		).toBe("接続を確認して、もう一度お試しください。");
	});

	test("文字列として渡された内部エラーも画面へ露出しない", () => {
		expect(
			userFacingErrorMessage(
				"SQLite DBのbackground応答を取得できません",
				"接続を確認して、もう一度お試しください。",
			),
		).toBe("接続を確認して、もう一度お試しください。");
	});

	test("利用者が対処できる説明は保持する", () => {
		expect(
			userFacingErrorMessage(
				new Error("保存先フォルダーを選び直してください。"),
				"もう一度お試しください。",
			),
		).toBe("保存先フォルダーを選び直してください。");
	});

	test("操作の文脈が必要な画面では安全な詳細だけを後ろへ添える", () => {
		expect(
			userFacingErrorMessage(new Error("保存先を選び直してください。"), "保存できませんでした。", {
				prefixFallback: true,
			}),
		).toBe("保存できませんでした。 保存先を選び直してください。");
	});
});
