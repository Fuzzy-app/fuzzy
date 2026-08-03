import {
	RULE_PRESETS,
	RULE_SEGMENT_LABELS,
	type RuleSegment,
	createRuleSegmentsFromTemplate,
	ruleSegmentsToTemplate,
	validateRuleSegments,
} from "@fuzzy/shared";
import type { PatternCandidate, SavedSetupConfiguration } from "./types";

export type SetupSelectionSnapshot = {
	baseFolderPath: string;
	patternId: string;
	courseSegmentIndex: number | null;
	ruleTemplate: string;
	courseNames: string[];
};

function normalizeTemplate(template: string): string {
	return template
		.trim()
		.split(/[\\/]/)
		.map((segment) => segment.trim())
		.join("/");
}

export function editableRuleSegmentsFromTemplate(template: string): RuleSegment[] | null {
	const segments = createRuleSegmentsFromTemplate(template);
	if (
		validateRuleSegments(segments) !== null ||
		ruleSegmentsToTemplate(segments) !== normalizeTemplate(template)
	) {
		return null;
	}
	return segments;
}

export function createStoredPatternCandidate(
	configuration: SavedSetupConfiguration,
): PatternCandidate {
	const segments = editableRuleSegmentsFromTemplate(configuration.rule.template);
	const name =
		segments
			?.map((segment) =>
				segment.kind === "fixed" ? (segment.value ?? "") : RULE_SEGMENT_LABELS[segment.kind],
			)
			.join(" / ") || "保存済みの構成";
	return {
		id: configuration.pattern.id,
		name,
		description: "現在保存されているフォルダーの見方です。",
		folders: [],
		directorySegments:
			segments?.map(({ kind, value, format }) => ({
				kind,
				...(value === undefined ? {} : { value }),
				...(format === undefined ? {} : { format }),
			})) ?? null,
		courseSegmentIndex: configuration.pattern.courseSegmentIndex,
		fileNameTemplate: null,
		matchScore: null,
		evaluatedCount: 0,
		reason: "再確認を行うまで、現在の設定をそのまま保持します。",
		recommended: true,
		requiresConfirmation: false,
	};
}

export function resolveRuleId(
	template: string,
	configuration: SavedSetupConfiguration | null,
): string {
	const normalized = normalizeTemplate(template);
	if (configuration && normalizeTemplate(configuration.rule.template) === normalized) {
		return configuration.rule.id;
	}
	return (
		RULE_PRESETS.find((preset) => normalizeTemplate(preset.template) === normalized)?.id ?? "custom"
	);
}

export function displayBaseFolderName(path: string | null): string {
	if (!path) return "まだ選択されていません";
	const normalized = path.replace(/[\\/]+$/, "");
	const name = normalized.split(/[\\/]/).pop()?.trim();
	return name || "選択した保存先";
}

export function configurationToSnapshot(
	configuration: SavedSetupConfiguration,
): SetupSelectionSnapshot {
	return {
		baseFolderPath: configuration.baseFolderPath,
		patternId: configuration.pattern.id,
		courseSegmentIndex: configuration.pattern.courseSegmentIndex,
		ruleTemplate: normalizeTemplate(configuration.rule.template),
		courseNames: configuration.courseOverrides
			.filter(({ mode }) => mode !== "common")
			.map(({ courseName }) => courseName)
			.sort((left, right) => left.localeCompare(right, "ja")),
	};
}

export function describeSetupChanges(
	original: SetupSelectionSnapshot,
	current: SetupSelectionSnapshot,
): string[] {
	const changes: string[] = [];
	if (original.baseFolderPath !== current.baseFolderPath) {
		changes.push("保存先を変更");
	}
	if (
		original.patternId !== current.patternId ||
		original.courseSegmentIndex !== current.courseSegmentIndex
	) {
		changes.push("既存フォルダーの見方を変更");
	}
	if (normalizeTemplate(original.ruleTemplate) !== normalizeTemplate(current.ruleTemplate)) {
		changes.push("フォルダーの作り方を変更");
	}
	const originalCourses = [...original.courseNames].sort((left, right) =>
		left.localeCompare(right, "ja"),
	);
	const currentCourses = [...current.courseNames].sort((left, right) =>
		left.localeCompare(right, "ja"),
	);
	if (
		originalCourses.length !== currentCourses.length ||
		originalCourses.some((courseName, index) => courseName !== currentCourses[index])
	) {
		changes.push("授業ごとの扱いを変更");
	}
	return changes;
}
