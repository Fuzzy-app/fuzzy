export type PatternCandidate = {
	id: string;
	name: string;
	description: string;
	folders: string[];
	matchScore: number;
	reason: string;
	recommended?: boolean;
};

export type InitialRuleOption = {
	id: string;
	name: string;
	description: string;
	template: string;
	preview: string[];
	recommended?: boolean;
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
