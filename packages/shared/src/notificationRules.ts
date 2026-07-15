export const MAX_NOTIFICATION_OFFSET_DAYS = 365;
export const MAX_NOTIFICATION_OFFSET_MINUTES = MAX_NOTIFICATION_OFFSET_DAYS * 24 * 60;

export type NotificationOffsetUnit = "minutes" | "hours" | "days";

const MINUTES_PER_UNIT: Record<NotificationOffsetUnit, number> = {
	minutes: 1,
	hours: 60,
	days: 24 * 60,
};

export function notificationOffsetMinutes(
	amount: number,
	unit: NotificationOffsetUnit,
): number | null {
	if (!Number.isInteger(amount) || amount < 0) return null;
	const offsetMinutes = amount * MINUTES_PER_UNIT[unit];
	if (!Number.isSafeInteger(offsetMinutes) || offsetMinutes > MAX_NOTIFICATION_OFFSET_MINUTES) {
		return null;
	}
	return offsetMinutes;
}

export function isValidNotificationOffsetMinutes(offsetMinutes: number): boolean {
	return (
		Number.isSafeInteger(offsetMinutes) &&
		offsetMinutes >= 0 &&
		offsetMinutes <= MAX_NOTIFICATION_OFFSET_MINUTES
	);
}

/** 表示名を分数から一意に生成し、保存値とラベルの不一致を防ぐ。 */
export function notificationRuleLabel(offsetMinutes: number): string {
	if (offsetMinutes === 0) return "締切時刻";
	if (offsetMinutes % (24 * 60) === 0) return `${offsetMinutes / (24 * 60)}日前`;
	if (offsetMinutes % 60 === 0) return `${offsetMinutes / 60}時間前`;
	if (offsetMinutes > 60) {
		const hours = Math.floor(offsetMinutes / 60);
		const minutes = offsetMinutes % 60;
		return `${hours}時間${minutes}分前`;
	}
	return `${offsetMinutes}分前`;
}
