/**
 * 入力順を保ったまま同時実行数を制限する。
 * 失敗後は新しい処理を開始せず、実行中のworkerが収束してから同じエラーを返す。
 */
export async function boundedParallelMap<T, R>(
	values: readonly T[],
	concurrency: number,
	mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (!Number.isInteger(concurrency) || concurrency <= 0) {
		throw new RangeError("concurrencyには正の整数を指定してください");
	}

	const results = new Array<R>(values.length);
	let nextIndex = 0;
	let failed = false;
	let firstError: unknown;

	async function runWorker(): Promise<void> {
		while (!failed && nextIndex < values.length) {
			const index = nextIndex++;
			const value = values[index] as T;
			try {
				results[index] = await mapper(value, index);
			} catch (error) {
				if (!failed) firstError = error;
				failed = true;
			}
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(concurrency, values.length) }, () => runWorker()),
	);
	if (failed) throw firstError;
	return results;
}
