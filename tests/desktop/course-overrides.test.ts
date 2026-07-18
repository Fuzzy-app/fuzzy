import { describe, expect, test } from "bun:test";
import { scanExistingStructureClient } from "../../apps/desktop/src/lib/setup/api";
import { createCourseOverrides } from "../../apps/desktop/src/lib/setup/course-overrides";
import type { PatternCandidate } from "../../apps/desktop/src/lib/setup/types";

const sampleCourseNames = [
	"情報アーキテクチャ",
	"データベース",
	"離散数学",
	"アプリ演習",
	"認知科学概論",
	"英語IIB",
];

const baseCandidate: PatternCandidate = {
	id: "year-course-assignment",
	name: "年度 / 科目 / 課題",
	description: "",
	folders: [],
	courseSegmentIndex: 1,
	matchScore: 100,
	reason: "",
};

describe("createCourseOverrides", () => {
	test("選択パターンの科目位置から重複排除後に3件を抽出する", () => {
		const candidate: PatternCandidate = {
			...baseCandidate,
			folders: [
				"2026",
				"2026/情報アーキテクチャ",
				"2026/情報アーキテクチャ/第03回レポート",
				"2026/データベース/正規化レポート",
				"2026/離散数学/小テスト",
				"2026/アプリ演習/第05回制作課題",
			],
		};

		expect(createCourseOverrides(candidate).map(({ courseName }) => courseName)).toEqual([
			"情報アーキテクチャ",
			"データベース",
			"離散数学",
		]);
	});

	test("科目セグメントを持たないパターンでは例外候補を作らない", () => {
		const candidate: PatternCandidate = {
			...baseCandidate,
			folders: ["情報アーキテクチャ_第03回レポート"],
			courseSegmentIndex: null,
		};

		expect(createCourseOverrides(candidate)).toEqual([]);
	});

	test("スキャンモックの年度候補に共通サンプル6科目を含む", async () => {
		const candidates = await scanExistingStructureClient("C:/Users/hirot/Documents/Fuzzy");
		const candidate = candidates.find(({ id }) => id === "year-course-assignment");

		if (!candidate || candidate.courseSegmentIndex === null) {
			throw new Error("年度候補に科目セグメントがありません。");
		}

		const { courseSegmentIndex } = candidate;
		const courseNames = Array.from(
			new Set(
				candidate.folders.map((folder) => folder.split("/")[courseSegmentIndex]).filter(Boolean),
			),
		);

		expect(courseNames).toEqual(sampleCourseNames);
	});
});
