import { describe, expect, test } from "bun:test";
import { MockApiClient } from "../../packages/shared/src/api/mockClient";

describe("excluded folder settings", () => {
	test("replaces root and course entries independently", async () => {
		const api = new MockApiClient();

		await api.updateExcludedFolders({
			scope: "root",
			courseId: null,
			paths: ["materials", "materials\\drafts"],
		});
		await api.updateExcludedFolders({
			scope: "course",
			courseId: 1,
			paths: ["submissions"],
		});

		const folders = await api.getExcludedFolders(1);
		expect(folders.map((folder) => `${folder.scope}:${folder.relativePath}`)).toEqual([
			"root:materials",
			"root:materials/drafts",
			"course:submissions",
		]);

		await api.updateExcludedFolders({
			scope: "course",
			courseId: 1,
			paths: [],
		});
		expect(await api.getExcludedFolders(1)).toEqual([
			expect.objectContaining({ scope: "root", relativePath: "materials" }),
			expect.objectContaining({ scope: "root", relativePath: "materials/drafts" }),
		]);
	});

	test("rejects absolute and parent-relative paths", async () => {
		const api = new MockApiClient();

		await expect(
			api.updateExcludedFolders({ scope: "root", courseId: null, paths: ["C:/Users"] }),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		await expect(
			api.updateExcludedFolders({ scope: "course", courseId: 1, paths: ["../outside"] }),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
	});
});
