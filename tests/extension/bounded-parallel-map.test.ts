import { describe, expect, test } from "bun:test";
import { boundedParallelMap } from "../../apps/extension/src/lib/boundedParallelMap";

describe("boundedParallelMap", () => {
	test("入力順を保ち、同時実行数を上限以内にする", async () => {
		let active = 0;
		let maximumActive = 0;
		const result = await boundedParallelMap([1, 2, 3, 4], 2, async (value) => {
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			await new Promise((resolve) => setTimeout(resolve, 0));
			active -= 1;
			return value * 2;
		});

		expect(result).toEqual([2, 4, 6, 8]);
		expect(maximumActive).toBe(2);
	});

	test("失敗後は新しい処理を始めず、実行中workerの終了を待つ", async () => {
		let releaseSecond: (() => void) | undefined;
		let settled = false;
		const called: number[] = [];
		const operation = boundedParallelMap([0, 1, 2], 2, async (value) => {
			called.push(value);
			if (value === 0) throw new Error("照合失敗");
			if (value === 1) {
				await new Promise<void>((resolve) => {
					releaseSecond = resolve;
				});
			}
			return value;
		});
		void operation
			.finally(() => {
				settled = true;
			})
			.catch(() => undefined);

		await waitFor(() => called.length === 2);
		expect(called).toEqual([0, 1]);
		expect(settled).toBe(false);

		releaseSecond?.();
		await expect(operation).rejects.toThrow("照合失敗");
		expect(called).toEqual([0, 1]);
		expect(settled).toBe(true);
	});
});

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("条件が時間内に成立しませんでした");
}
