import { defineConfig } from "wxt";
import { MOODLE_HTTPS_MATCH_PATTERNS } from "./moodleSite";

/**
 * 同梱するunpacked拡張のIDをインストール先パスに依存させない公開鍵。
 * Native Messagingホストは、この鍵から導出されるIDだけをallowed_originsへ登録する。
 */
export const FUZZY_EXTENSION_PUBLIC_KEY =
	"MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqSVgHbsIUGS9L/iUcHzGGrcu+6ontzkTCsMth63MIXb8dQ+WhZfSaaKjZl+DPF4yzmK3dd9y0+NTC44b7D+7SmJk3kTu+RQ3/7spHLVh9S7apRdfNYhHVCGRDQYq4+VLl7fNR+dvyP6Jcp8RriHmrSZ4wHJuQe+YiEIt7xSjGVH/xBVHijhu+UnP6IhISSfmvG5oM09OHLKk0LLpWl9IWafPyYtAP9HZbVWJvqsZ0Lr6lwJp7hNgFSXWfwyFNKQsaupcKmd7a9Z2/sRxhs4RMomAg7eS7WtMkOpFfPuVo5x3SQMwWLvYGg7QjFO73YqCkDSavlXaAHOT7E30hlHXswIDAQAB";
export const FUZZY_EXTENSION_ID = "edainabflfdaibonfpckomlaocmemagg";

// See https://wxt.dev/api/config.html
export default defineConfig({
	srcDir: "src",
	manifestVersion: 3,
	modules: ["@wxt-dev/module-svelte"],
	manifest: {
		name: "Fuzzy",
		short_name: "Fuzzy",
		key: FUZZY_EXTENSION_PUBLIC_KEY,
		host_permissions: [...MOODLE_HTTPS_MATCH_PATTERNS],
		web_accessible_resources: [
			{
				// Moodle DOMへ挿入する画面用SVGだけを公開する。
				// 通知・拡張機能メニュー用PNGはextension内部から参照するため公開不要。
				resources: ["icon/fuzzy.svg"],
				matches: [...MOODLE_HTTPS_MATCH_PATTERNS],
			},
		],
		permissions: [
			// native-host（Rust）とのNative Messaging接続に使用（仕様書3.4節）。
			// 接続はbackground(service worker)へ集約している（lib/api/backgroundApi.ts）。
			"nativeMessaging",
			// 保存パネルの「前回と同じ場所」で直近の保存先を記憶するために使用。
			"storage",
			// 同期完了を定期確認し、取得結果をブラウザ通知で伝えるために使用。
			"alarms",
			"notifications",
		],
	},
});
