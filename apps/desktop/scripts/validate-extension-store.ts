import {
	createSupportedBrowserOptions,
	extensionStoreUrls,
	getPreferredExtensionInstallChannel,
} from "../src/lib/setup/extension-install";
import type { ExtensionStoreUrls, SupportedBrowserId } from "../src/lib/setup/extension-install";

const supportedBrowserIds: readonly SupportedBrowserId[] = ["chrome", "edge"];

export function validateExtensionStoreUrls(
	storeUrls: ExtensionStoreUrls = extensionStoreUrls,
): void {
	const options = createSupportedBrowserOptions(storeUrls);

	for (const browserId of supportedBrowserIds) {
		if (getPreferredExtensionInstallChannel(browserId, options) !== "store") {
			throw new Error(
				`${browserId}の公式ストアURLが未設定または許可対象外です。同梱を外す前に公開URLを設定してください。`,
			);
		}
	}
}

if (import.meta.main) {
	try {
		validateExtensionStoreUrls();
		console.log("Chrome／Edgeの公式ストアURLを確認しました。");
	} catch (error) {
		console.error(error instanceof Error ? error.message : "公式ストアURLを確認できませんでした。");
		process.exit(1);
	}
}
