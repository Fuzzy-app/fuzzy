import { describe, expect, test } from "bun:test";

const themeCss = await Bun.file(
	new URL("../../packages/shared/src/styles/theme.css", import.meta.url),
).text();

function cssColor(variableName: string): string {
	const match = themeCss.match(new RegExp(`${variableName}:\\s*(#[0-9a-fA-F]{6});`));
	if (!match?.[1]) throw new Error(`${variableName}に16進数の色が定義されていません`);
	return match[1];
}

function relativeLuminance(hex: string): number {
	const channels = [1, 3, 5].map(
		(offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
	);
	const [red, green, blue] = channels.map((channel) =>
		channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
	);
	return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0);
}

function contrastRatio(first: string, second: string): number {
	const firstLuminance = relativeLuminance(first);
	const secondLuminance = relativeLuminance(second);
	return (
		(Math.max(firstLuminance, secondLuminance) + 0.05) /
		(Math.min(firstLuminance, secondLuminance) + 0.05)
	);
}

describe("共通テーマのコントラスト", () => {
	test("semantic色の通常文字がsoft背景で4.5:1以上になる", () => {
		const semanticPairs = [
			["--fuzzy-color-primary-strong", "--fuzzy-color-primary-soft"],
			["--fuzzy-color-success-strong", "--fuzzy-color-success-soft"],
			["--fuzzy-color-info", "--fuzzy-color-info-soft"],
			["--fuzzy-color-warning", "--fuzzy-color-warning-soft"],
			["--fuzzy-color-danger", "--fuzzy-color-danger-soft"],
		] as const;

		for (const [foreground, background] of semanticPairs) {
			expect(contrastRatio(cssColor(foreground), cssColor(background))).toBeGreaterThanOrEqual(4.5);
		}
	});

	test("フォーカスリングが明背景と暗いサイドバーで3:1以上になる", () => {
		expect(
			contrastRatio(cssColor("--fuzzy-focus-ring"), cssColor("--fuzzy-color-surface")),
		).toBeGreaterThanOrEqual(3);
		expect(
			contrastRatio(cssColor("--fuzzy-focus-ring-inverse"), cssColor("--fuzzy-color-sidebar")),
		).toBeGreaterThanOrEqual(3);
	});
});
