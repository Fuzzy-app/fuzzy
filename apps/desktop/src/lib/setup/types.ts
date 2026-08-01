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

export type SavedSetupConfiguration = {
	revision: string;
	savedAt: string;
	baseFolderPath: string;
	pattern: {
		id: string;
		courseSegmentIndex: number | null;
	};
	rule: {
		id: string;
		template: string;
	};
	courseOverrides: Array<{
		courseName: string;
		enabled: true;
	}>;
};

export type SetupChangesPayload = InitialSetupPayload & {
	expectedRevision: string;
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
