import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const REPOSITORY_ROOT = join(import.meta.dir, "..", "..");
const UI_ROOTS = [
	join(REPOSITORY_ROOT, "apps", "desktop", "src"),
	join(REPOSITORY_ROOT, "apps", "extension", "src"),
	join(REPOSITORY_ROOT, "apps", "site"),
];
const STYLE_SOURCE_EXTENSIONS = new Set([".css", ".svelte", ".ts"]);
const COLOR_LITERAL_PATTERN = /#[0-9a-f]{6,8}\b|rgba?\(/gi;

function sourceFiles(directory: string): string[] {
	return readdirSync(directory).flatMap((name) => {
		const path = join(directory, name);
		if (name === "dist" || name === "node_modules") return [];
		return statSync(path).isDirectory()
			? sourceFiles(path)
			: STYLE_SOURCE_EXTENSIONS.has(extname(path))
				? [path]
				: [];
	});
}

describe("共通UI theme token", () => {
	test("アプリ固有コードへ色リテラルを増やさない", () => {
		const violations = UI_ROOTS.flatMap(sourceFiles).flatMap((path) => {
			const matches = readFileSync(path, "utf8").match(COLOR_LITERAL_PATTERN) ?? [];
			return matches.map((literal) => `${relative(REPOSITORY_ROOT, path)}: ${literal}`);
		});

		expect(violations).toEqual([]);
	});
});
