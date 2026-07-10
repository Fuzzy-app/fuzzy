import type { PatternCandidate } from "./types";

const mockBaseFolders = [
	"C:/Users/hirot/Documents/Fuzzy",
	"D:/School/Fuzzy",
	"C:/Users/hirot/Desktop/講義資料",
];

const mockScanResultsByPath: Record<string, PatternCandidate[]> = {
	"C:/Users/hirot/Documents/Fuzzy": [
		{
			id: "year-course-assignment",
			name: "年度 / 科目 / 課題",
			description: "年度単位でまとめつつ、各科目の中に課題フォルダを配置する構成です。",
			folders: ["2026", "2026/情報アーキテクチャ", "2026/情報アーキテクチャ/第03回レポート"],
			matchScore: 92,
			reason: "年度フォルダと科目名フォルダの並びが最も多く見つかりました。",
			recommended: true,
		},
		{
			id: "course-assignment",
			name: "科目 / 課題",
			description: "シンプルに科目ごとで分け、その下に課題を入れる構成です。",
			folders: ["情報アーキテクチャ", "情報アーキテクチャ/第03回レポート", "統計学/中間課題"],
			matchScore: 76,
			reason: "年度がないフォルダも一部含まれていたため候補として残しています。",
		},
		{
			id: "download-flat",
			name: "単一フォルダ保存",
			description: "ダウンロード先を固定し、課題名だけで管理する構成です。",
			folders: ["第03回レポート", "統計学_中間課題", "発表資料"],
			matchScore: 41,
			reason: "課題名のみのフォルダが少数存在しました。",
		},
	],
	"D:/School/Fuzzy": [
		{
			id: "semester-course",
			name: "学期 / 科目",
			description: "前期・後期の粒度で整理してから科目に分ける構成です。",
			folders: ["2026前期", "2026前期/統計学", "2026前期/統計学/中間課題"],
			matchScore: 88,
			reason: "学期名フォルダの直下に科目フォルダが揃っていました。",
			recommended: true,
		},
		{
			id: "course-week",
			name: "科目 / 回次",
			description: "科目ごとに回次や講義日で整理する構成です。",
			folders: ["統計学/第01回", "統計学/第02回", "HCI/第05回"],
			matchScore: 63,
			reason: "回次表記が複数見つかったため副候補にしています。",
		},
	],
	"C:/Users/hirot/Desktop/講義資料": [
		{
			id: "course-flat",
			name: "科目ごとにひとまとめ",
			description: "まずは科目単位でまとめ、細かい分割は後続設定に回す構成です。",
			folders: ["認知科学", "認知科学/配布資料", "認知科学/提出物"],
			matchScore: 71,
			reason: "提出物と資料が同居する科目フォルダが多く見つかりました。",
			recommended: true,
		},
	],
};

let mockFolderIndex = 0;

export async function pickBaseFolderClient(): Promise<string | null> {
	const folder = mockBaseFolders[mockFolderIndex % mockBaseFolders.length];

	mockFolderIndex += 1;

	return Promise.resolve(folder);
}

export async function scanExistingStructureClient(path: string): Promise<PatternCandidate[]> {
	return Promise.resolve(mockScanResultsByPath[path] ?? []);
}
