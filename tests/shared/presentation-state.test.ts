import { describe, expect, test } from "bun:test";
import { presentationProgressLabel } from "../../packages/shared/src/presentationState";

describe("利用者向け状態表示", () => {
	test("進捗件数を範囲内に補正して表示する", () => {
		expect(
			presentationProgressLabel({
				phase: "資料を確認中",
				completed: 12,
				total: 10,
			}),
		).toBe("資料を確認中（10/10件）");
	});

	test("総数がない処理では段階名だけを表示する", () => {
		expect(
			presentationProgressLabel({
				phase: "接続を確認中",
				completed: -1,
				total: 0,
			}),
		).toBe("接続を確認中");
	});
});
