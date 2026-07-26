import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
	// 相対パスにすることで、Organization Pages と /fuzzy/ 配下の両方で表示できる。
	base: "./",
	build: {
		outDir: "dist",
		emptyOutDir: true,
		rollupOptions: {
			input: {
				main: fileURLToPath(new URL("./index.html", import.meta.url)),
				privacy: fileURLToPath(new URL("./privacy.html", import.meta.url)),
			},
		},
	},
});
