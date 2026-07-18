import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	type DuplicateGroupListItem,
	type RuleSet,
	type RuleViolationListItem,
	relativeSavePath,
} from "@fuzzy/shared";
import duplicateGroupsJson from "../../packages/shared/src/sample-data/duplicate-groups.json";
import ruleViolationsJson from "../../packages/shared/src/sample-data/rule-violations.json";
import rulesJson from "../../packages/shared/src/sample-data/rules.json";

describe("SQLite seedと共有サンプルデータの整合", () => {
	test("ルール、違反一覧、重複一覧が同じ正本データを表す", async () => {
		const database = await openSeedDatabase();
		try {
			const basePath = database
				.query<{ value: string }, []>(
					"SELECT value FROM app_settings WHERE key = 'base_folder_path'",
				)
				.get()?.value;
			if (!basePath) throw new Error("seedにbase_folder_pathがありません");

			expect(readRules(database)).toEqual(rulesJson as RuleSet);
			expect(readViolations(database, basePath)).toEqual(
				ruleViolationsJson as RuleViolationListItem[],
			);
			expect(readDuplicateGroups(database, basePath)).toEqual(
				duplicateGroupsJson as DuplicateGroupListItem[],
			);
		} finally {
			database.close();
		}
	});
});

async function openSeedDatabase(): Promise<Database> {
	const schemaUrl = new URL("../../crates/engine-core/fixtures/schema.sql", import.meta.url);
	const seedUrl = new URL("../../crates/engine-core/fixtures/seed.sql", import.meta.url);
	const [schema, seed] = await Promise.all([Bun.file(schemaUrl).text(), Bun.file(seedUrl).text()]);
	const database = new Database(":memory:");
	database.exec("PRAGMA foreign_keys = ON;");
	database.exec(schema);
	database.exec(seed);
	return database;
}

function readRules(database: Database): RuleSet {
	const globalPatternTemplate = database
		.query<{ patternTemplate: string }, []>(
			"SELECT pattern_template AS patternTemplate FROM global_rule WHERE id = 1",
		)
		.get()?.patternTemplate;
	if (!globalPatternTemplate) throw new Error("seedにグローバルルールがありません");

	const courseOverrides = database
		.query<
			{
				courseId: number;
				courseName: string;
				splitBySection: number;
				patternTemplate: string | null;
				note: string | null;
			},
			[]
		>(
			`SELECT o.course_id AS courseId,
				c.name AS courseName,
				o.split_by_section AS splitBySection,
				o.pattern_template AS patternTemplate,
				o.note AS note
			FROM course_rule_overrides o
			JOIN courses c ON c.id = o.course_id
			ORDER BY o.course_id`,
		)
		.all()
		.map((override) => ({
			...override,
			splitBySection: override.splitBySection === 1,
		}));
	return { globalPatternTemplate, courseOverrides };
}

function readViolations(database: Database, basePath: string): RuleViolationListItem[] {
	return database
		.query<
			{
				fileId: number;
				fileName: string;
				courseId: number | null;
				courseName: string | null;
				savedPath: string;
				reason: string;
			},
			[]
		>(
			`SELECT f.id AS fileId,
				f.original_name AS fileName,
				f.course_id AS courseId,
				c.name AS courseName,
				f.saved_path AS savedPath,
				f.violation_reason AS reason
			FROM files f
			LEFT JOIN courses c ON c.id = f.course_id
			WHERE f.rule_compliant = 0
			ORDER BY f.id`,
		)
		.all()
		.map(({ savedPath, ...item }) => ({
			...item,
			relativePath: requireRelativePath(basePath, savedPath),
		}));
}

function readDuplicateGroups(database: Database, basePath: string): DuplicateGroupListItem[] {
	const groups = database
		.query<{ groupId: number; method: "exact" | "similar" }, []>(
			"SELECT id AS groupId, method FROM duplicate_groups ORDER BY id",
		)
		.all();
	return groups.map((group) => ({
		...group,
		members: database
			.query<
				{
					fileId: number;
					fileName: string;
					savedPath: string;
					similarity: number;
				},
				[number]
			>(
				`SELECT f.id AS fileId,
					f.original_name AS fileName,
					f.saved_path AS savedPath,
					m.similarity AS similarity
				FROM duplicate_members m
				JOIN files f ON f.id = m.file_id
				WHERE m.group_id = ?1
				ORDER BY f.id`,
			)
			.all(group.groupId)
			.map(({ savedPath, ...member }) => ({
				...member,
				relativePath: requireRelativePath(basePath, savedPath),
			})),
	}));
}

function requireRelativePath(basePath: string, savedPath: string): string {
	const relativePath = relativeSavePath(basePath, savedPath);
	if (!relativePath) throw new Error("seedの保存先がbase_folder_pathの外にあります");
	return relativePath;
}
