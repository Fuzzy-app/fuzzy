import type { CourseRuleOverrideInput, StructuredRuleSegment } from "./types";

export const RULE_TEMPLATE_TOKENS = ["year", "term", "course", "assignment", "section"] as const;

export type RuleTemplateToken = (typeof RULE_TEMPLATE_TOKENS)[number];

export const RULE_SEGMENT_KINDS = [
	"year",
	"term",
	"course",
	"assignment",
	"section",
	"fixed",
] as const;

export type RuleSegmentKind = (typeof RULE_SEGMENT_KINDS)[number];

export interface RuleSegment extends StructuredRuleSegment {
	id: string;
	kind: RuleSegmentKind;
}

export const RULE_SEGMENT_LABELS: Readonly<Record<RuleSegmentKind, string>> = {
	year: "年度",
	term: "学期",
	course: "科目",
	assignment: "課題",
	section: "授業回",
	fixed: "固定フォルダー名",
};

export interface RulePreset {
	id: string;
	name: string;
	description: string;
	template: string;
	recommended?: boolean;
}

export const RULE_PRESETS: readonly RulePreset[] = [
	{
		id: "year-course-assignment",
		name: "年度 / 科目 / 課題",
		description: "学年をまたいで資料が増えても、年度単位で見失いにくい標準ルールです。",
		template: "{year}/{course}/{assignment}",
		recommended: true,
	},
	{
		id: "semester-course-assignment",
		name: "学期 / 科目 / 課題",
		description: "前期・後期の区切りを優先して、履修中の科目を見渡しやすくします。",
		template: "{term}/{course}/{assignment}",
	},
	{
		id: "course-assignment",
		name: "科目 / 課題",
		description: "科目名を起点にした、短く扱いやすいルールです。",
		template: "{course}/{assignment}",
	},
];

export interface RulePreviewValues {
	year: string;
	term: string;
	course: string;
	assignment: string;
	section: string;
}

const windowsReservedNamePattern = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const tokenPattern = /\{([^{}]+)\}/g;
const segmentTokenPattern = /^\{(year|term|course|assignment|section)\}$/;
let ruleSegmentSequence = 0;

function createRuleSegmentId(kind: RuleSegmentKind): string {
	ruleSegmentSequence += 1;
	return `rule-segment-${ruleSegmentSequence}-${kind}`;
}

export function createRuleSegmentsFromTemplate(patternTemplate: string): RuleSegment[] {
	return patternTemplate
		.trim()
		.split(/[\\/]/)
		.filter(Boolean)
		.map((segment) => {
			const normalized = segment.trim();
			const token = normalized.match(segmentTokenPattern)?.[1] as RuleTemplateToken | undefined;
			if (token) return { id: createRuleSegmentId(token), kind: token };
			if (/^第\s*\{section\}\s*回$/.test(normalized)) {
				return {
					id: createRuleSegmentId("section"),
					kind: "section",
					format: "numbered",
				};
			}
			if (/^\{year\}年度$/.test(normalized)) {
				return {
					id: createRuleSegmentId("year"),
					kind: "year",
					format: "academicYearSuffix",
				};
			}
			if (/^\{year\}年$/.test(normalized)) {
				return {
					id: createRuleSegmentId("year"),
					kind: "year",
					format: "yearSuffix",
				};
			}
			return {
				id: createRuleSegmentId("fixed"),
				kind: "fixed",
				value: normalized,
			};
		});
}

export function createRuleSegment(kind: RuleSegmentKind, _index: number, value = ""): RuleSegment {
	return {
		id: createRuleSegmentId(kind),
		kind,
		...(kind === "fixed" ? { value } : {}),
	};
}

export function ruleSegmentsToTemplate(segments: readonly RuleSegment[]): string {
	return segments
		.map((segment) => {
			if (segment.kind === "fixed") return (segment.value ?? "").trim();
			if (segment.kind === "section" && segment.format === "numbered") {
				return "第{section}回";
			}
			if (segment.kind === "year" && segment.format === "academicYearSuffix") {
				return "{year}年度";
			}
			if (segment.kind === "year" && segment.format === "yearSuffix") {
				return "{year}年";
			}
			return `{${segment.kind}}`;
		})
		.join("/");
}

export function validateRuleSegments(segments: readonly RuleSegment[]): string | null {
	if (segments.length === 0) return "フォルダーの並びを1つ以上追加してください。";
	const courseCount = segments.filter(({ kind }) => kind === "course").length;
	if (courseCount === 0) return "「科目」は必ず1つ追加してください。";
	if (courseCount > 1) return "「科目」は重複して追加できません。";

	const seenKinds = new Set<RuleSegmentKind>();
	for (const segment of segments) {
		if (segment.kind !== "fixed") {
			if (
				(segment.format === "numbered" && segment.kind !== "section") ||
				((segment.format === "yearSuffix" || segment.format === "academicYearSuffix") &&
					segment.kind !== "year")
			) {
				return "選択したフォルダー項目の表示形式を使用できません。";
			}
			if (seenKinds.has(segment.kind)) {
				return `「${RULE_SEGMENT_LABELS[segment.kind]}」は重複して追加できません。`;
			}
			seenKinds.add(segment.kind);
			continue;
		}
		const rawValue = segment.value ?? "";
		const value = rawValue.trim();
		if (!value) return "固定フォルダー名を入力してください。";
		if (rawValue !== value) {
			return "固定フォルダー名の前後に空白は使用できません。";
		}
		if (/[{}]/.test(value)) {
			return "固定フォルダー名に波括弧は使用できません。";
		}
		if (/^(?:[a-z]:[\\/]|[\\/]{1,2})/i.test(value)) {
			return "固定フォルダー名に絶対パスやUNCパスは指定できません。";
		}
		if (value === "." || value === ".." || /[\\/]/.test(value)) {
			return "固定フォルダー名には「.」「..」やパス区切りを使用できません。";
		}
		if ([...value].some(isInvalidWindowsPathCharacter)) {
			return "固定フォルダー名にWindowsで使用できない文字が含まれています。";
		}
		if (/[. ]$/.test(value)) {
			return "固定フォルダー名の末尾にピリオドや空白は使用できません。";
		}
		if (windowsReservedNamePattern.test(value)) {
			return `Windowsの予約名「${value}」は固定フォルダー名に使用できません。`;
		}
	}
	return validateRulePattern(ruleSegmentsToTemplate(segments));
}

export function previewRuleSegments(
	segments: readonly RuleSegment[],
	values: RulePreviewValues = createRulePreviewValues(),
): string {
	return segments
		.map((segment) => {
			if (segment.kind === "fixed") return (segment.value ?? "").trim();
			if (segment.kind === "section" && segment.format === "numbered") {
				return `第${values.section}回`;
			}
			if (segment.kind === "year" && segment.format === "academicYearSuffix") {
				return `${values.year}年度`;
			}
			if (segment.kind === "year" && segment.format === "yearSuffix") {
				return `${values.year}年`;
			}
			return values[segment.kind];
		})
		.filter(Boolean)
		.join(" / ");
}

export function createRulePreviewValues(now = new Date()): RulePreviewValues {
	const calendarYear = now.getFullYear();
	const month = now.getMonth() + 1;
	const academicYear = month < 4 ? calendarYear - 1 : calendarYear;
	const term = month >= 4 && month < 10 ? "前期" : "後期";
	return {
		year: String(academicYear),
		term: `${academicYear}${term}`,
		course: "アプリ演習",
		assignment: "第05回制作課題",
		section: "05",
	};
}

export function validateRulePattern(patternTemplate: string): string | null {
	const normalized = patternTemplate.trim();
	if (!normalized) return "テンプレートを入力してください。";
	if (!normalized.includes("{course}")) return "テンプレートには {course} を含めてください。";
	if (/^(?:[a-z]:[\\/]|[\\/]{1,2})/i.test(normalized)) {
		return "絶対パスやUNCパスは指定できません。";
	}
	if ([...normalized].some(isInvalidWindowsPathCharacter)) {
		return "Windowsのフォルダ名に使用できない文字が含まれています。";
	}

	const allowedTokens = new Set<string>(RULE_TEMPLATE_TOKENS);
	for (const match of normalized.matchAll(tokenPattern)) {
		const token = match[1];
		if (token && !allowedTokens.has(token)) return `未対応の項目 {${token}} が含まれています。`;
	}
	const withoutKnownTokens = normalized.replace(tokenPattern, "x");
	if (/[{}]/.test(withoutKnownTokens)) return "テンプレートの波括弧が対応していません。";

	const segments = normalized.split(/[\\/]/);
	if (segments.some((segment) => segment.length === 0)) {
		return "空のフォルダ階層は指定できません。";
	}
	for (const segment of segments) {
		const staticSegment = segment.replace(tokenPattern, "x").trim();
		if (staticSegment === "." || staticSegment === "..") {
			return ". や .. を使った相対移動は指定できません。";
		}
		if (/[. ]$/.test(staticSegment)) {
			return "フォルダ名の末尾にピリオドや空白は使用できません。";
		}
		if (windowsReservedNamePattern.test(staticSegment)) {
			return `Windowsの予約名 ${staticSegment} は使用できません。`;
		}
	}
	return null;
}

function isInvalidWindowsPathCharacter(character: string): boolean {
	return '<>:"|?*'.includes(character) || character.charCodeAt(0) < 32;
}

export function validateCourseRuleOverride(
	override: CourseRuleOverrideInput,
	globalPatternTemplate: string,
): string | null {
	const effectivePattern = override.patternTemplate?.trim() || globalPatternTemplate;
	const patternError = validateRulePattern(effectivePattern);
	if (patternError) return patternError;
	if (!override.splitBySection && effectivePattern.includes("{section}")) {
		return "回ごとに分けない場合は、フォルダーの並びから「授業回」を外してください。";
	}
	if (override.splitBySection && !effectivePattern.includes("{section}")) {
		return "回ごとに分ける場合は、フォルダーの並びに「授業回」を追加してください。";
	}
	return null;
}

export function previewRulePattern(
	patternTemplate: string,
	values: RulePreviewValues = createRulePreviewValues(),
): string {
	const normalized = patternTemplate.trim();
	if (!normalized) return "グローバルルールを継承";
	return normalized.replace(tokenPattern, (match, token: string) => {
		return token in values ? values[token as RuleTemplateToken] : match;
	});
}

/** 保存先候補の生成でもプレビューと同じトークン置換規則を使う。 */
export function resolveRulePattern(patternTemplate: string, values: RulePreviewValues): string {
	return previewRulePattern(patternTemplate, values)
		.split(/[\\/]+/)
		.map((segment) => segment.trim())
		.filter(Boolean)
		.join("\\");
}

export function removeSectionSegment(patternTemplate: string): string {
	const segments = patternTemplate
		.split(/[\\/]/)
		.map((segment) =>
			segment
				.replace(/第\s*\{section\}\s*回/g, "")
				.replace(/\{section\}/g, "")
				.replace(/(?:\s*[-_–—:：]\s*){2,}/g, "-")
				.replace(/^\s*[-_–—:：]+|[-_–—:：]+\s*$/g, "")
				.trim(),
		)
		.filter(Boolean);
	const patternWithoutSection = segments.join("/");
	if (!patternWithoutSection) return "{course}";
	return patternWithoutSection.includes("{course}")
		? patternWithoutSection
		: `${patternWithoutSection}/{course}`;
}
