export interface CourseFolderIdentity {
	name: string;
	stableId: string;
}

const EMOJI_PATTERN = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\uFE0F|\u200D|\u20E3)/gu;
const BRACKETED_NOTE_PATTERN = /\s*(?:\([^()]*\)|\[[^\[\]]*\])\s*/g;
const WINDOWS_INVALID_CHARACTER_PATTERN = /[<>:"/\\|?*]/g;

/** Moodle上の補足表記と絵文字を除き、保存先に使う簡潔なフォルダ名へ正規化する。 */
export function folderSegment(value: string): string {
	const normalized = normalizeFolderText(value);
	const withoutNotes = removeBalancedNotes(normalized);
	return normalizeFolderText(withoutNotes);
}

/**
 * コース名を簡略化する。同じ名前へ簡略化されるコースがある場合は、
 * Moodleの安定IDを付けて異なる授業の資料が同じフォルダへ混ざらないようにする。
 */
export function courseFolderName(
	courseName: string,
	knownCourses: readonly CourseFolderIdentity[] = [],
	stableId?: string,
): string {
	const original = normalizeFolderText(courseName) || "不明なコース";
	const simplified = folderSegment(original) || "不明なコース";
	const simplifiedKey = comparisonKey(simplified);
	const hasCollision = knownCourses.some((course) => {
		const otherName = normalizeFolderText(course.name);
		return (
			comparisonKey(otherName) !== comparisonKey(original) &&
			comparisonKey(folderSegment(otherName)) === simplifiedKey
		);
	});

	if (!hasCollision) return simplified;

	const knownIdentity = knownCourses.find(
		(course) => comparisonKey(course.name) === comparisonKey(original),
	);
	const suffix = normalizeStableId(stableId ?? knownIdentity?.stableId ?? stableHash(original));
	return `${simplified}_${suffix}`;
}

function removeBalancedNotes(value: string): string {
	let current = value;
	while (true) {
		const next = current.replace(BRACKETED_NOTE_PATTERN, " ");
		if (next === current) return current;
		current = next;
	}
}

function normalizeFolderText(value: string): string {
	return value.normalize("NFKC").replace(EMOJI_PATTERN, "").replace(/\s+/g, " ").trim();
}

function normalizeStableId(value: string): string {
	const normalized = normalizeFolderText(value)
		.replace(WINDOWS_INVALID_CHARACTER_PATTERN, "-")
		.replace(/[()[\]]/g, "-")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return normalized || stableHash(value);
}

function comparisonKey(value: string): string {
	return normalizeFolderText(value).toLocaleLowerCase("en-US");
}

function stableHash(value: string): string {
	let hash = 2_166_136_261;
	for (const character of value) {
		hash ^= character.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16_777_619);
	}
	return `course-${(hash >>> 0).toString(36)}`;
}
