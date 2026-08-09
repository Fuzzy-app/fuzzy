import { describe, expect, test } from "bun:test";
import { buildSearchQueryVariants } from "./search";

describe("buildSearchQueryVariants", () => {
	test("原文を先頭に保って英数字語の後ろの助詞を外す", () => {
		expect(buildSearchQueryVariants("Pythonを高速化")).toEqual(["Pythonを高速化", "Python 高速化"]);
	});

	test("通常の日本語は不用意に分割しない", () => {
		expect(buildSearchQueryVariants("提出方法を確認")).toEqual(["提出方法を確認"]);
	});
});
