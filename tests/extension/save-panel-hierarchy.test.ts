import { describe, expect, test } from "bun:test";
import { groupSavePanelFiles } from "../../apps/extension/src/entrypoints/content/savePanelHierarchy";
import type { MoodleFileLink } from "../../apps/extension/src/lib/moodle/pageSnapshot";

describe("資料保存パネルの階層表示", () => {
	test("同じセクションの資料を入力順のまままとめる", () => {
		const groups = groupSavePanelFiles([
			file("正規化.pdf", "第4回"),
			file("SQL演習.docx", "第5回"),
			file("正規化_補足.pdf", "第4回"),
		]);
		expect(groups.map((group) => [group.label, group.files.map((item) => item.title)])).toEqual([
			["第4回", ["正規化.pdf", "正規化_補足.pdf"]],
			["第5回", ["SQL演習.docx"]],
		]);
	});

	test("所属を取得できない資料も失わず専用グループへまとめる", () => {
		const groups = groupSavePanelFiles([file("ガイダンス.pdf", null)]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.label).toBe("セクションを確認できない資料");
		expect(groups[0]?.files[0]?.title).toBe("ガイダンス.pdf");
	});
});

function file(title: string, sectionTitle: string | null): MoodleFileLink {
	return {
		title,
		url: `https://moodle.example/pluginfile.php/1/${encodeURIComponent(title)}`,
		moodleFileId: "1",
		sectionTitle,
		mimeHint: "pdf",
	};
}
