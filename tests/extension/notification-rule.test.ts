import { describe, expect, test } from "bun:test";
import {
	MAX_NOTIFICATION_OFFSET_MINUTES,
	notificationOffsetMinutes,
	notificationRuleLabel,
} from "@fuzzy/shared";

describe("任意の通知タイミング", () => {
	test("分・時間・日を締切からの分数へ変換する", () => {
		expect(notificationOffsetMinutes(30, "minutes")).toBe(30);
		expect(notificationOffsetMinutes(2, "hours")).toBe(120);
		expect(notificationOffsetMinutes(3, "days")).toBe(4320);
	});

	test("表示名を保存値から一意に生成する", () => {
		expect(notificationRuleLabel(0)).toBe("締切時刻");
		expect(notificationRuleLabel(90)).toBe("1時間30分前");
		expect(notificationRuleLabel(540)).toBe("9時間前");
		expect(notificationRuleLabel(2880)).toBe("2日前");
	});

	test("負数・小数・365日を超える値を拒否する", () => {
		expect(notificationOffsetMinutes(-1, "minutes")).toBeNull();
		expect(notificationOffsetMinutes(1.5, "hours")).toBeNull();
		expect(notificationOffsetMinutes(MAX_NOTIFICATION_OFFSET_MINUTES + 1, "minutes")).toBeNull();
	});
});
