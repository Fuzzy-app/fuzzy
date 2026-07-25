import { describe, expect, test } from "bun:test";
import {
	type MoodleNativeSessionPort,
	maintainMoodleNativeSession,
} from "../../apps/extension/src/lib/runtime/moodleNativeSession";

class FakePort implements MoodleNativeSessionPort {
	readonly listeners: Array<() => void> = [];
	readonly onDisconnect = {
		addListener: (listener: () => void) => {
			this.listeners.push(listener);
		},
	};
	disconnected = false;

	disconnect(): void {
		if (this.disconnected) return;
		this.disconnected = true;
		for (const listener of this.listeners) listener();
	}
}

interface ScheduledCallback {
	callback: () => void;
	delayMs: number;
	cancelled: boolean;
}

function createScheduler() {
	const scheduled: ScheduledCallback[] = [];
	return {
		scheduled,
		setTimer(callback: () => void, delayMs: number): ScheduledCallback {
			const timer = { callback, delayMs, cancelled: false };
			scheduled.push(timer);
			return timer;
		},
		clearTimer(timer: unknown): void {
			(timer as ScheduledCallback).cancelled = true;
		},
		runNext(): void {
			const timer = scheduled.find((item) => !item.cancelled);
			if (!timer) throw new Error("実行可能なタイマーがありません");
			timer.cancelled = true;
			timer.callback();
		},
	};
}

describe("Moodle native session", () => {
	test("Service Worker側の切断後にMoodleタブから再接続する", () => {
		const scheduler = createScheduler();
		const ports: FakePort[] = [];
		const dispose = maintainMoodleNativeSession({
			connect: () => {
				const port = new FakePort();
				ports.push(port);
				return port;
			},
			isPageActive: () => true,
			setTimer: scheduler.setTimer,
			clearTimer: scheduler.clearTimer,
		});

		expect(ports).toHaveLength(1);
		ports[0]?.disconnect();
		expect(scheduler.scheduled[0]?.delayMs).toBe(250);
		scheduler.runNext();
		expect(ports).toHaveLength(2);

		dispose();
		expect(ports[1]?.disconnected).toBe(true);
		expect(scheduler.scheduled.filter((timer) => !timer.cancelled)).toHaveLength(0);
	});

	test("ページ破棄後は切断されても再接続しない", () => {
		const scheduler = createScheduler();
		const port = new FakePort();
		let pageActive = true;
		const dispose = maintainMoodleNativeSession({
			connect: () => port,
			isPageActive: () => pageActive,
			setTimer: scheduler.setTimer,
			clearTimer: scheduler.clearTimer,
		});

		pageActive = false;
		dispose();

		expect(port.disconnected).toBe(true);
		expect(scheduler.scheduled).toHaveLength(0);
	});

	test("接続失敗は上限付き指数バックオフで再試行する", () => {
		const scheduler = createScheduler();
		let attempts = 0;
		const dispose = maintainMoodleNativeSession({
			connect: () => {
				attempts += 1;
				throw new Error("service worker unavailable");
			},
			isPageActive: () => true,
			setTimer: scheduler.setTimer,
			clearTimer: scheduler.clearTimer,
			initialRetryMs: 100,
			maxRetryMs: 200,
		});

		expect(attempts).toBe(1);
		expect(scheduler.scheduled[0]?.delayMs).toBe(100);
		scheduler.runNext();
		expect(attempts).toBe(2);
		expect(scheduler.scheduled[1]?.delayMs).toBe(200);

		dispose();
		expect(scheduler.scheduled[1]?.cancelled).toBe(true);
	});
});
