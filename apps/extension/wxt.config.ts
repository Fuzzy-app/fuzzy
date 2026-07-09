import { defineConfig } from "wxt";

// See https://wxt.dev/api/config.html
export default defineConfig({
	srcDir: "src",
	modules: ["@wxt-dev/module-svelte"],
	manifest: {
		permissions: [
			// native-host（Rust）とのNative Messaging接続に使用（仕様書3.4節）。
			// 接続はbackground(service worker)へ集約している（lib/api/backgroundApi.ts）。
			"nativeMessaging",
			// 保存パネルの「前回と同じ場所」で直近の保存先を記憶するために使用。
			"storage",
		],
	},
});
