import type { InitialSetupPayload, PatternCandidate, SetupStatus } from "./types";

const setupStorageKey = "fuzzy.desktop.initialSetup";

const mockBaseFolders = [
	"C:/Users/hirot/Documents/Fuzzy",
	"D:/School/Fuzzy",
	"C:/Users/hirot/Desktop/講義資料",
];

const mockCourses = [
	{ name: "情報アーキテクチャ", assignment: "第03回レポート" },
	{ name: "データベース", assignment: "正規化レポート" },
	{ name: "離散数学", assignment: "小テスト" },
	{ name: "アプリ演習", assignment: "第05回制作課題" },
	{ name: "認知科学概論", assignment: "期末レポート" },
	{ name: "英語IIB", assignment: "単語テスト" },
] as const;

function createMockCourseFolders(prefix?: string): string[] {
	return mockCourses.map(({ name, assignment }) =>
		[prefix, name, assignment].filter(Boolean).join("/"),
	);
}

const mockScanResultsByPath: Record<string, PatternCandidate[]> = {
	"C:/Users/hirot/Documents/Fuzzy": [
		{
			id: "year-course-assignment",
			name: "年度 / 科目 / 課題",
			description: "年度単位でまとめつつ、各科目の中に課題フォルダを配置する構成です。",
			folders: ["2026", ...createMockCourseFolders("2026")],
			courseSegmentIndex: 1,
			matchScore: 92,
			reason: "年度フォルダと科目名フォルダの並びが最も多く見つかりました。",
			recommended: true,
		},
		{
			id: "course-assignment",
			name: "科目 / 課題",
			description: "シンプルに科目ごとで分け、その下に課題を入れる構成です。",
			folders: createMockCourseFolders(),
			courseSegmentIndex: 0,
			matchScore: 76,
			reason: "年度がないフォルダも一部含まれていたため候補として残しています。",
		},
		{
			id: "download-flat",
			name: "単一フォルダ保存",
			description: "ダウンロード先を固定し、課題名だけで管理する構成です。",
			folders: mockCourses.map(({ name, assignment }) => `${name}_${assignment}`),
			courseSegmentIndex: null,
			matchScore: 41,
			reason: "課題名のみのフォルダが少数存在しました。",
		},
	],
	"D:/School/Fuzzy": [
		{
			id: "semester-course",
			name: "学期 / 科目",
			description: "前期・後期の粒度で整理してから科目に分ける構成です。",
			folders: ["2026前期", ...createMockCourseFolders("2026前期")],
			courseSegmentIndex: 1,
			matchScore: 88,
			reason: "学期名フォルダの直下に科目フォルダが揃っていました。",
			recommended: true,
		},
		{
			id: "course-week",
			name: "科目 / 回次",
			description: "科目ごとに回次や講義日で整理する構成です。",
			folders: createMockCourseFolders(),
			courseSegmentIndex: 0,
			matchScore: 63,
			reason: "回次表記が複数見つかったため副候補にしています。",
		},
	],
	"C:/Users/hirot/Desktop/講義資料": [
		{
			id: "course-flat",
			name: "科目ごとにひとまとめ",
			description: "まずは科目単位でまとめ、細かい分割は後続設定に回す構成です。",
			folders: createMockCourseFolders(),
			courseSegmentIndex: 0,
			matchScore: 71,
			reason: "提出物と資料が同居する科目フォルダが多く見つかりました。",
			recommended: true,
		},
	],
};

let mockFolderIndex = 0;
let memorySavedSetup: { payload: InitialSetupPayload; savedAt: string } | null = null;

function canUseLocalStorage(): boolean {
	return typeof localStorage !== "undefined";
}

export async function pickBaseFolderClient(): Promise<string | null> {
	const folder = mockBaseFolders[mockFolderIndex % mockBaseFolders.length] ?? null;

	mockFolderIndex += 1;

	return Promise.resolve(folder);
}

export async function scanExistingStructureClient(path: string): Promise<PatternCandidate[]> {
	return Promise.resolve(mockScanResultsByPath[path] ?? []);
}

export async function saveInitialSetupClient(payload: InitialSetupPayload): Promise<{ ok: true }> {
	const savedAt = new Date().toISOString();

	memorySavedSetup = { payload, savedAt };

	if (canUseLocalStorage()) {
		localStorage.setItem(setupStorageKey, JSON.stringify(memorySavedSetup));
	}

	return Promise.resolve({ ok: true });
}

export async function getSetupStatusClient(): Promise<SetupStatus> {
	if (memorySavedSetup) {
		return Promise.resolve({ done: true, savedAt: memorySavedSetup.savedAt });
	}

	if (!canUseLocalStorage()) {
		return Promise.resolve({ done: false });
	}

	const savedSetup = localStorage.getItem(setupStorageKey);

	if (!savedSetup) {
		return Promise.resolve({ done: false });
	}

	try {
		const parsed = JSON.parse(savedSetup) as { savedAt?: string };

		return Promise.resolve({ done: true, savedAt: parsed.savedAt });
	} catch {
		localStorage.removeItem(setupStorageKey);

		return Promise.resolve({ done: false });
	}
}
