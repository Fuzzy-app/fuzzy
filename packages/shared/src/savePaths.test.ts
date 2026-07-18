import { describe, expect, test } from "bun:test";
import {
	canonicalWindowsPath,
	inferSaveRoot,
	normalizeRelativeSavePath,
	relativeSavePath,
	resolveSavePathUnderRoot,
	splitWindowsPath,
} from "./savePaths";

describe("保存ルート以下のWindowsパス", () => {
	test("区切り文字と大文字小文字の差を吸収する", () => {
		expect(canonicalWindowsPath("C:/Users/Sample/大学/")).toBe(
			canonicalWindowsPath("c:\\users\\sample\\大学"),
		);
		expect(splitWindowsPath("2026前期\\データベース/第4回")).toEqual([
			"2026前期",
			"データベース",
			"第4回",
		]);
	});

	test("絶対パス・相対移動・Windows予約名を拒否する", () => {
		expect(normalizeRelativeSavePath("C:\\Temp")).toBeNull();
		expect(normalizeRelativeSavePath("2026前期/../Temp")).toBeNull();
		expect(normalizeRelativeSavePath("2026前期/CON")).toBeNull();
		expect(normalizeRelativeSavePath("2026前期/データベース")).toBe("2026前期\\データベース");
	});

	test("保存候補からルートを復元し、ルート外のパスは相対化しない", () => {
		const root = "C:\\Users\\sample\\Documents\\大学";
		const relative = "2026前期\\データベース";
		const absolute = resolveSavePathUnderRoot(root, relative);
		expect(absolute).toBe(`${root}\\${relative}`);
		expect(inferSaveRoot(absolute ?? "", relative)).toBe(root);
		expect(relativeSavePath(root, absolute ?? "")).toBe(relative);
		expect(relativeSavePath(root, "D:\\別の場所")).toBeNull();
	});
});
