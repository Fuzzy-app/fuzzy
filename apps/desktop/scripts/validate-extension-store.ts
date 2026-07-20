import { extensionStoreUrl, isAllowedExtensionStoreUrl } from "../src/lib/setup/extension-install";

export function validateExtensionStoreUrl(storeUrl: string | null = extensionStoreUrl): void {
	if (!isAllowedExtensionStoreUrl(storeUrl)) {
		throw new Error(
			"公式配布ページのURLが未設定または拡張機能詳細ページではありません。同梱を外す前に公開URLを設定してください。",
		);
	}
}

if (import.meta.main) {
	try {
		validateExtensionStoreUrl();
		console.log("Fuzzyの公式配布ページURLを確認しました。");
	} catch (error) {
		console.error(
			error instanceof Error ? error.message : "公式配布ページを確認できませんでした。",
		);
		process.exit(1);
	}
}
