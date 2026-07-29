import type { MoodleFileLink } from "../../lib/moodle/pageSnapshot";

export interface SavePanelFileGroup {
	key: string;
	label: string;
	files: MoodleFileLink[];
}

/** 資料保存パネルで、Moodleのセクション階層を安定した表示グループへ変換する。 */
export function groupSavePanelFiles(files: readonly MoodleFileLink[]): SavePanelFileGroup[] {
	const groups = new Map<string, MoodleFileLink[]>();
	for (const file of files) {
		const label = file.sectionTitle?.trim() || "セクションを確認できない資料";
		const group = groups.get(label) ?? [];
		group.push(file);
		groups.set(label, group);
	}
	return Array.from(groups, ([label, groupedFiles]) => ({
		key: label,
		label,
		files: groupedFiles,
	}));
}
