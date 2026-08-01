import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import wxtConfig, {
	FUZZY_EXTENSION_ID,
	FUZZY_EXTENSION_PUBLIC_KEY,
} from "../../apps/extension/wxt.config";

const ICON_SIZES = [16, 32, 48, 96, 128] as const;
const MOODLE_HTTPS_MATCH_PATTERN = "https://*.wakayama-u.ac.jp/*";

type ManifestConfig = {
	key?: string;
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

		const shellElementsSource = await Bun.file(
			new URL("../../apps/extension/src/entrypoints/content/shellElements.ts", import.meta.url),
		).text();
		expect(shellElementsSource).toContain('BRAND_ICON_PATH = "/icon/fuzzy.svg"');
		expect(shellElementsSource).not.toContain("/icon/128.png");
	});

	test("Native Messagingの許可元に使う固定拡張IDをmanifest公開鍵から導出できる", () => {
		const manifest = (wxtConfig as { manifest?: ManifestConfig }).manifest;
		expect(manifest?.key).toBe(FUZZY_EXTENSION_PUBLIC_KEY);

		const digest = createHash("sha256")
			.update(Buffer.from(FUZZY_EXTENSION_PUBLIC_KEY, "base64"))
			.digest()
			.subarray(0, 16);
		const derivedId = [...digest]
			.flatMap((byte) => [byte >> 4, byte & 0x0f])
			.map((nibble) => String.fromCharCode("a".charCodeAt(0) + nibble))
			.join("");
		expect(derivedId).toBe(FUZZY_EXTENSION_ID);
	});

	test("content scriptはNative Messagingへ直接接続せずbackground APIを使う", async () => {
		const shellSource = await Bun.file(
			new URL("../../apps/extension/src/entrypoints/content/shell.ts", import.meta.url),
		).text();
		expect(shellSource).toContain("new BackgroundApiClient()");
		expect(shellSource).not.toContain("createApiClient()");
		expect(shellSource).not.toContain("connectNative");
		expect(shellSource).toContain("readDashboardCacheFromBackground()");
		expect(shellSource).not.toContain('from "../../lib/cache/dashboardCache"');
		expect(shellSource).not.toContain("writeDashboardCache(");
	});
});
