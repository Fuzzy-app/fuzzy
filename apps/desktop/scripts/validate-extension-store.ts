import { extensionStoreUrl, isAllowedExtensionStoreUrl } from "../src/lib/setup/extension-install";
import { validateDistributionConfiguration } from "./prepare-extension";

export function validateExtensionStoreUrl(storeUrl: string | null = extensionStoreUrl): void {
	if (!isAllowedExtensionStoreUrl(storeUrl)) {
		throw new Error(
			"公式配布ページのURLが未設定または拡張機能詳細ページではありません。同梱を外す前に公開URLを設定してください。",
		);
	}
}

export async function validateStoreDistribution(): Promise<void> {
	await validateDistributionConfiguration();
	validateExtensionStoreUrl();
}

if (import.meta.main) {
	try {
		await validateStoreDistribution();
		console.log("Fuzzyの公式配布ページURLを確認しました。");
	} catch (error) {
		console.error(
			error instanceof Error ? error.message : "公式配布ページを確認できませんでした。",
		);
		process.exit(1);
	}
}
