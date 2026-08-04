import { describe, expect, test } from "bun:test";
import { ApiError } from "@fuzzy/shared";
import {
	nativeConnectionIssuePresentation,
	userFacingErrorMessage,
} from "../../apps/extension/src/entrypoints/content/userFacingError";

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

	test("Native Messaging接続失敗は対応バージョンと復旧手順へ案内する", () => {
		expect(
			nativeConnectionIssuePresentation(
				new ApiError("NO_NATIVE_HOST", "native-hostとの接続が切れました"),
			),
		).toEqual({
			statusLabel: "Fuzzy本体に接続できません",
			title: "Fuzzy本体と接続できませんでした。",
			impact:
				"同じ対応バージョンのFuzzyを起動して初期設定を確認してください。「接続を自動修復」が表示された場合は実行し、ブラウザとMoodleを開き直してください。解消しない場合はFuzzyの復旧画面または再インストールを利用してください。",
		});
	});

	test("内部エラーはNative Messagingの復旧案内と誤認しない", () => {
		expect(nativeConnectionIssuePresentation(new Error("通信に失敗しました"))).toBeNull();
		expect(
			nativeConnectionIssuePresentation(new ApiError("DB_ERROR", "DBを開けません")),
		).toBeNull();
	});

	test("Native Messagingの応答待ち超過は本体の起動へ案内する", () => {
		expect(
			nativeConnectionIssuePresentation(new ApiError("TIMEOUT", "pingが応答しません")),
		).toEqual({
			statusLabel: "Fuzzy本体から応答がありません",
			title: "Fuzzy本体から応答がありませんでした。",
			impact: "同じ対応バージョンのFuzzyを一度起動してから、ブラウザとMoodleを開き直してください。",
		});
	});
});
