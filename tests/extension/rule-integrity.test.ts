import { describe, expect, spyOn, test } from "bun:test";
import type { DuplicateGroupListItem, RuleViolationListItem } from "@fuzzy/shared";
import { parseHTML } from "linkedom";
import { createRuleIntegrityPanel } from "../../apps/extension/src/entrypoints/content/ruleIntegrityPanel";
import {
	duplicateMethodLabel,
	summarizeRuleIntegrity,
} from "../../apps/extension/src/lib/integrity/ruleIntegrity";
import {
	type RuleIntegrityApi,
	RuleIntegrityController,
} from "../../apps/extension/src/lib/integrity/state";

const violations: RuleViolationListItem[] = [
	{
		fileId: 4,
		fileName: "正規化_メモ.docx",
		courseId: 2,
		courseName: "データベース",
		relativePath: "正規化_メモ.docx",
		reason: "グローバルルールから外れています",
	},
	{
		fileId: 8,
		fileName: "ER図.pdf",
		courseId: 8,
		courseName: "データベース",
		relativePath: "2026前期\\ER図.pdf",
		reason: "別の同名授業に保存されています",
	},
	{
		fileId: 9,
		fileName: "第4回_正規化(1).pdf",
		courseId: null,
		courseName: null,
		relativePath: "ダウンロード\\第4回_正規化(1).pdf",
		reason: "授業との対応を確認してください",
	},
];

const duplicateGroups: DuplicateGroupListItem[] = [
	{
		groupId: 1,
		method: "exact",
		members: [
			{
				fileId: 3,
				fileName: "第4回_正規化.pdf",
				relativePath: "2026前期\\データベース\\第4回\\第4回_正規化.pdf",
				similarity: 1,
			},
			{
				fileId: 9,
				fileName: "第4回_正規化.pdf",
				relativePath: "ダウンロード\\第4回_正規化.pdf",
				similarity: 1,
			},
		],
	},
	{
		groupId: 2,
		method: "similar",
		members: [
			{
				fileId: 9,
				fileName: "第4回_正規化.pdf",
				relativePath: "ダウンロード\\第4回_正規化.pdf",
				similarity: 0.92,
			},
			{
				fileId: 10,
				fileName: "正規化まとめ.pdf",
				relativePath: "2026前期\\データベース\\正規化まとめ.pdf",
				similarity: 0,
			},
		],
	},
];

const primaryViolation = violations[0];
const similarDuplicateGroup = duplicateGroups[1];
if (!primaryViolation || !similarDuplicateGroup) {
	throw new Error("テストfixtureの初期化に失敗しました");
}

describe("ルール違反・重複候補の集計", () => {
	test("授業名ではなくcourseIdで数え、未紐付け授業と重複fileIdを重ねて数えない", () => {
		expect(summarizeRuleIntegrity(violations, duplicateGroups)).toEqual({
			violationCount: 3,
			affectedCourseCount: 2,
			duplicateGroupCount: 2,
			duplicateFileCount: 3,
		});
	});

	test("重複判定方法を利用者向けの表示へ変換する", () => {
		expect(duplicateMethodLabel("exact")).toBe("完全一致");
		expect(duplicateMethodLabel("similar")).toBe("類似");
	});
});

describe("整理が必要な資料パネル", () => {
	test("空状態を案内し、更新ボタンで両一覧を再取得する", async () => {
		let violationCalls = 0;
		let duplicateCalls = 0;
		const root = setupPanel({
			getRuleViolations: async () => {
				violationCalls += 1;
				await Promise.resolve();
				return [];
			},
			getDuplicateGroups: async () => {
				duplicateCalls += 1;
				await Promise.resolve();
				return [];
			},
		});
		await root.panel.activate();

		expect(root.element.textContent).toContain(
			"保存場所や名前が保存ルールと異なる資料は見つかりませんでした",
		);
		expect(root.element.textContent).toContain("同じ・よく似た資料は見つかりませんでした");
		root.element.querySelector<HTMLButtonElement>(".fuzzy-integrity-button.is-primary")?.click();
		await root.panel.refresh();
		expect(violationCalls).toBe(2);
		expect(duplicateCalls).toBe(2);
	});

	test("相対パスで同名ファイルを区別し、外部文字列をHTMLとして解釈しない", async () => {
		const root = setupPanel({
			getRuleViolations: async () => [
				{
					...primaryViolation,
					courseName: '<img src="x" onerror="alert(1)">',
					reason: "<script>alert(1)</script>",
				},
			],
			getDuplicateGroups: async () => duplicateGroups,
		});
		await root.panel.activate();

		expect(root.element.textContent).toContain('<img src="x" onerror="alert(1)">');
		expect(root.element.textContent).toContain("<script>alert(1)</script>");
		expect(root.element.querySelector("img")).toBeNull();
		expect(root.element.querySelector("script")).toBeNull();
		expect(root.element.textContent).toContain("2026前期\\データベース\\第4回\\第4回_正規化.pdf");
		expect(root.element.textContent).toContain("ダウンロード\\第4回_正規化.pdf");
		expect(root.element.textContent).not.toContain("C:\\Users");
	});

	test("命名だけの違反も案内し、保存ルート名を固定しない", async () => {
		const root = setupPanel({
			getRuleViolations: async () => [
				{
					...primaryViolation,
					fileName: "講義資料.pdf",
					relativePath: "情報アーキテクチャ\\講義資料.pdf",
					reason: "保存場所は正しいですが、ファイル名が命名ルールと異なります",
				},
			],
			getDuplicateGroups: async () => [],
		});
		await root.panel.activate();

		expect(root.element.textContent).toContain("保存場所や名前が保存ルールと異なる資料");
		expect(root.element.textContent).toContain(
			"保存場所は正しいですが、ファイル名が命名ルールと異なります",
		);
		expect(root.element.textContent).toContain("保存ルート › 情報アーキテクチャ\\講義資料.pdf");
		expect(root.element.textContent).not.toContain("Fuzzyフォルダ");
	});

	test("重複候補だけ失敗しても保存ルールと異なる資料を残し、失敗側だけ再読込できる", async () => {
		const warning = spyOn(console, "warn").mockImplementation(() => undefined);
		let duplicateCalls = 0;
		const root = setupPanel({
			getRuleViolations: async () => violations,
			getDuplicateGroups: async () => {
				duplicateCalls += 1;
				if (duplicateCalls === 1) {
					throw new Error("C:\\Users\\secret\\fuzzy.db を開けません");
				}
				return duplicateGroups;
			},
		});
		await root.panel.activate();

		expect(root.element.textContent).toContain("正規化_メモ.docx");
		expect(root.element.textContent).toContain("同じ可能性がある資料を取得できませんでした");
		expect(root.element.textContent).not.toContain("C:\\Users\\secret");

		root.element.querySelector<HTMLButtonElement>(".fuzzy-integrity-alert button")?.click();
		await root.panel.refresh("duplicates");

		expect(duplicateCalls).toBe(2);
		expect(root.element.textContent).toContain("候補の組み合わせ 1");
		warning.mockRestore();
	});

	test("違反一覧だけ失敗しても重複候補を表示する", async () => {
		const warning = spyOn(console, "warn").mockImplementation(() => undefined);
		const root = setupPanel({
			getRuleViolations: async () => {
				throw new Error("raw backend failure");
			},
			getDuplicateGroups: async () => duplicateGroups,
		});
		await root.panel.activate();

		expect(root.element.textContent).toContain(
			"保存場所や名前が保存ルールと異なる資料を取得できませんでした",
		);
		expect(root.element.textContent).not.toContain("raw backend failure");
		expect(root.element.textContent).toContain("候補の組み合わせ 1");
		warning.mockRestore();
	});

	test("絶対パスと範囲外の類似度をAPI境界で拒否し、DOMへ出さない", async () => {
		const warning = spyOn(console, "warn").mockImplementation(() => undefined);
		const root = setupPanel({
			getRuleViolations: async () => [
				{
					...primaryViolation,
					relativePath: "C:\\Users\\secret\\正規化_メモ.docx",
				},
			],
			getDuplicateGroups: async () => [
				{
					...similarDuplicateGroup,
					members: similarDuplicateGroup.members.map((member, index) => ({
						...member,
						similarity: index === 0 ? 1.01 : member.similarity,
					})),
				},
			],
		});
		await root.panel.activate();

		expect(root.element.querySelectorAll(".fuzzy-integrity-alert")).toHaveLength(2);
		expect(root.element.textContent).not.toContain("C:\\Users\\secret");
		warning.mockRestore();
	});

	test("理由文の途中に埋め込まれた絶対パスもDOMへ出さない", async () => {
		const warning = spyOn(console, "warn").mockImplementation(() => undefined);
		const root = setupPanel({
			getRuleViolations: async () => [
				{
					...primaryViolation,
					reason: "保存先C:\\Users\\secret\\正規化_メモ.docxを確認してください",
				},
			],
			getDuplicateGroups: async () => duplicateGroups,
		});
		await root.panel.activate();

		expect(root.element.textContent).toContain(
			"保存場所や名前が保存ルールと異なる資料を取得できませんでした",
		);
		expect(root.element.textContent).not.toContain("C:\\Users\\secret");
		expect(root.element.textContent).toContain("候補の組み合わせ 1");
		warning.mockRestore();
	});

	test("再表示時は両一覧を更新し、無効化後の古い応答で上書きしない", async () => {
		let violationCalls = 0;
		let duplicateCalls = 0;
		let resolveOld!: (items: RuleViolationListItem[]) => void;
		const oldRequest = new Promise<RuleViolationListItem[]>((resolve) => {
			resolveOld = resolve;
		});
		const root = setupPanel({
			getRuleViolations: async () => {
				violationCalls += 1;
				if (violationCalls === 1) return oldRequest;
				return [{ ...primaryViolation, fileName: "最新.pdf", relativePath: "最新.pdf" }];
			},
			getDuplicateGroups: async () => {
				duplicateCalls += 1;
				return duplicateGroups;
			},
		});

		const firstActivation = root.panel.activate();
		root.panel.invalidate("violations");
		await root.panel.refresh("violations");
		resolveOld([{ ...primaryViolation, fileName: "古い.pdf", relativePath: "古い.pdf" }]);
		await firstActivation;

		expect(root.element.textContent).toContain("最新.pdf");
		expect(root.element.textContent).not.toContain("古い.pdf");
		root.panel.deactivate();
		await root.panel.activate();
		expect(violationCalls).toBe(3);
		expect(duplicateCalls).toBe(2);
	});
});

function setupPanel(api: RuleIntegrityApi): {
	element: HTMLElement;
	panel: ReturnType<typeof createRuleIntegrityPanel>;
} {
	const { document, window } = parseHTML("<html><head></head><body></body></html>");
	Object.assign(globalThis, {
		document,
		window,
		HTMLElement: window.HTMLElement,
		HTMLButtonElement: window.HTMLButtonElement,
	});
	const panel = createRuleIntegrityPanel(new RuleIntegrityController(api));
	document.body.append(panel.root);
	return { element: panel.root, panel };
}
