import { describe, expect, test } from "bun:test";
import wxtConfig from "../../apps/extension/wxt.config";

const ICON_SIZES = [16, 32, 48, 96, 128] as const;
const MOODLE_HTTPS_MATCH_PATTERN = "https://*.wakayama-u.ac.jp/*";

type ManifestConfig = {
	web_accessible_resources?: Array<{
		resources?: string[];
		matches?: string[];
	}>;
};

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
	expect(Array.from(bytes.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
	expect(new TextDecoder().decode(bytes.subarray(12, 16))).toBe("IHDR");

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return {
		width: view.getUint32(16),
		height: view.getUint32(20),
	};
}

describe("拡張機能アイコン", () => {
	for (const size of ICON_SIZES) {
		test(`${size}px用PNGが正しい寸法である`, async () => {
			const icon = Bun.file(
				new URL(`../../apps/extension/public/icon/${size}.png`, import.meta.url),
			);
			const bytes = new Uint8Array(await icon.arrayBuffer());

			// 透明な空画像を誤って生成しても、寸法だけでは検知できないため、
			// 現在の粒子・グラデーションを持つアイコンとして十分なデータ量も確認する。
			expect(bytes.byteLength).toBeGreaterThan((size * size) / 2);
			expect(pngDimensions(bytes)).toEqual({ width: size, height: size });
		});
	}
});

describe("Moodle向け公開範囲", () => {
	test("Manifest V3でSVGとContent Scriptを同じHTTPS originだけに公開する", async () => {
		expect(wxtConfig.manifestVersion).toBe(3);
		const manifest = (wxtConfig as { manifest?: ManifestConfig }).manifest;
		expect(manifest?.web_accessible_resources).toEqual([
			{
				resources: ["icon/fuzzy.svg"],
				matches: [MOODLE_HTTPS_MATCH_PATTERN],
			},
		]);

		const contentScriptSource = await Bun.file(
			new URL("../../apps/extension/src/entrypoints/content/index.ts", import.meta.url),
		).text();
		expect(contentScriptSource).toContain(`matches: ["${MOODLE_HTTPS_MATCH_PATTERN}"]`);
		expect(contentScriptSource).not.toContain("*://*.wakayama-u.ac.jp/*");
	});
});
