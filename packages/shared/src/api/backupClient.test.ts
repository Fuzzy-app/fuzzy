import { describe, expect, test } from "bun:test";

import { MockApiClient } from "./mockClient";

describe("バックアップAPI", () => {
	test("mockではSQLite正本を偽装せずnative-host必須エラーにする", async () => {
		const client = new MockApiClient();
		await expect(client.exportData({ filePath: "backup.db" })).rejects.toMatchObject({
			code: "NO_NATIVE_HOST",
		});
		await expect(client.importData({ filePath: "backup.db" })).rejects.toMatchObject({
			code: "NO_NATIVE_HOST",
		});
	});
});
