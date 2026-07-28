import type { InitialScanPatternCandidate, RulePreset } from "@fuzzy/shared";

export type PatternCandidate = InitialScanPatternCandidate;

export type InitialRuleOption = RulePreset & {
	preview: string[];
};

export type CourseOverride = {
	id: string;
	courseName: string;
	description: string;
	enabled: boolean;
};

export type InitialSetupPayload = {
	path: string;
	pattern: PatternCandidate;
	rule: InitialRuleOption;
	courseOverrides: CourseOverride[];
};

export type SetupStatus = {
	done: boolean;
	savedAt?: string;
};

export type SetupDraft = {
	baseFolderPath: string | null;
	selectedCandidateId: string | null;
	selectedRuleId: string | null;
	candidates: PatternCandidate[];
	courseOverrides: CourseOverride[];
	lastScannedAt: string | null;
};
