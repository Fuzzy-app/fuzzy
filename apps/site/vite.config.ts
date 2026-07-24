import { defineConfig } from "vite";

export default defineConfig({
	// 相対パスにすることで、Organization Pages と /fuzzy/ 配下の両方で表示できる。
	base: "./",
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
});
