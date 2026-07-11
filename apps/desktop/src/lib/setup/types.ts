export type PatternCandidate = {
	id: string;
	name: string;
	description: string;
	folders: string[];
	matchScore: number;
	reason: string;
	recommended?: boolean;
};

export type SetupDraft = {
	baseFolderPath: string | null;
	selectedCandidateId: string | null;
	candidates: PatternCandidate[];
	lastScannedAt: string | null;
};
