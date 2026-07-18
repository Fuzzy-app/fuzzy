import {
	type DuplicateGroupListItem,
	type FuzzyApiClient,
	type RuleViolationListItem,
	normalizeRelativeSavePath,
} from "@fuzzy/shared";

export type RuleIntegrityApi = Pick<FuzzyApiClient, "getRuleViolations" | "getDuplicateGroups">;
export type RuleIntegrityTarget = "all" | "violations" | "duplicates";
export type RuleIntegrityResourceStatus = "idle" | "loading" | "ready" | "error";

export interface RuleIntegrityResource<T> {
	status: RuleIntegrityResourceStatus;
	data: T[];
}

export interface RuleIntegrityState {
	violations: RuleIntegrityResource<RuleViolationListItem>;
	duplicates: RuleIntegrityResource<DuplicateGroupListItem>;
}

export type RuleIntegrityStateListener = (state: Readonly<RuleIntegrityState>) => void;

/**
 * 警告と重複候補を独立して取得する状態管理。
 * 片方の失敗で他方の結果を失わず、古いリクエストの完了も無視する。
 */
export class RuleIntegrityController {
	readonly #api: RuleIntegrityApi;
	readonly #listeners = new Set<RuleIntegrityStateListener>();
	#state: RuleIntegrityState = {
		violations: { status: "idle", data: [] },
		duplicates: { status: "idle", data: [] },
	};
	#active = false;
	#violationGeneration = 0;
	#duplicateGeneration = 0;
	#violationPromise: Promise<void> | null = null;
	#duplicatePromise: Promise<void> | null = null;

	constructor(api: RuleIntegrityApi) {
		this.#api = api;
	}

	get snapshot(): Readonly<RuleIntegrityState> {
		return cloneState(this.#state);
	}

	subscribe(listener: RuleIntegrityStateListener): () => void {
		this.#listeners.add(listener);
		listener(this.snapshot);
		return () => this.#listeners.delete(listener);
	}

	activate(): Promise<void> {
		if (this.#active) {
			return Promise.all([this.#violationPromise, this.#duplicatePromise]).then(() => undefined);
		}
		this.#active = true;
		return this.refresh("all");
	}

	deactivate(): void {
		this.#active = false;
	}

	async refresh(target: RuleIntegrityTarget = "all"): Promise<void> {
		const requests: Promise<void>[] = [];
		if (target !== "duplicates") requests.push(this.#loadViolations());
		if (target !== "violations") requests.push(this.#loadDuplicates());
		await Promise.all(requests);
	}

	invalidate(target: RuleIntegrityTarget = "all"): void {
		if (target !== "duplicates") {
			this.#violationGeneration += 1;
			this.#violationPromise = null;
			this.#setResource("violations", { status: "idle" });
		}
		if (target !== "violations") {
			this.#duplicateGeneration += 1;
			this.#duplicatePromise = null;
			this.#setResource("duplicates", { status: "idle" });
		}
		if (this.#active) void this.refresh(target);
	}

	#loadViolations(): Promise<void> {
		if (this.#violationPromise) return this.#violationPromise;
		const generation = ++this.#violationGeneration;
		this.#setResource("violations", { status: "loading" });
		const request = this.#api
			.getRuleViolations()
			.then((items) => validateRuleViolations(items))
			.then((items) => {
				if (generation !== this.#violationGeneration) return;
				this.#setResource("violations", { status: "ready", data: items });
			})
			.catch((error: unknown) => {
				if (generation !== this.#violationGeneration) return;
				console.warn("[fuzzy] ルール違反一覧を取得できませんでした", error);
				this.#setResource("violations", { status: "error" });
			})
			.finally(() => {
				if (generation === this.#violationGeneration) this.#violationPromise = null;
			});
		this.#violationPromise = request;
		return request;
	}

	#loadDuplicates(): Promise<void> {
		if (this.#duplicatePromise) return this.#duplicatePromise;
		const generation = ++this.#duplicateGeneration;
		this.#setResource("duplicates", { status: "loading" });
		const request = this.#api
			.getDuplicateGroups()
			.then((items) => validateDuplicateGroups(items))
			.then((items) => {
				if (generation !== this.#duplicateGeneration) return;
				this.#setResource("duplicates", { status: "ready", data: items });
			})
			.catch((error: unknown) => {
				if (generation !== this.#duplicateGeneration) return;
				console.warn("[fuzzy] 重複候補を取得できませんでした", error);
				this.#setResource("duplicates", { status: "error" });
			})
			.finally(() => {
				if (generation === this.#duplicateGeneration) this.#duplicatePromise = null;
			});
		this.#duplicatePromise = request;
		return request;
	}

	#setResource<K extends keyof RuleIntegrityState>(
		key: K,
		patch: Partial<RuleIntegrityState[K]>,
	): void {
		this.#state = {
			...this.#state,
			[key]: { ...this.#state[key], ...patch },
		};
		for (const listener of this.#listeners) listener(this.snapshot);
	}
}

function validateRuleViolations(items: RuleViolationListItem[]): RuleViolationListItem[] {
	return items.map((item) => {
		if (
			!Number.isInteger(item.fileId) ||
			item.fileId <= 0 ||
			!isSafeFileName(item.fileName) ||
			!isSafeRelativeFilePath(item.relativePath, item.fileName) ||
			(item.courseId === null) !== (item.courseName === null) ||
			(item.courseId !== null && (!Number.isInteger(item.courseId) || item.courseId <= 0)) ||
			(item.courseName !== null && !isSafeDisplayText(item.courseName)) ||
			!isSafeDisplayText(item.reason)
		) {
			throw new Error("ルール違反一覧の形式がAPI契約と一致しません");
		}
		return { ...item };
	});
}

function validateDuplicateGroups(items: DuplicateGroupListItem[]): DuplicateGroupListItem[] {
	return items.map((group) => {
		if (
			!Number.isInteger(group.groupId) ||
			group.groupId <= 0 ||
			(group.method !== "exact" && group.method !== "similar") ||
			!Array.isArray(group.members) ||
			group.members.length < 2
		) {
			throw new Error("重複候補の形式がAPI契約と一致しません");
		}
		const members = group.members.map((member) => {
			if (
				!Number.isInteger(member.fileId) ||
				member.fileId <= 0 ||
				!isSafeFileName(member.fileName) ||
				!isSafeRelativeFilePath(member.relativePath, member.fileName) ||
				!Number.isFinite(member.similarity) ||
				member.similarity < 0 ||
				member.similarity > 1 ||
				(group.method === "exact" && member.similarity !== 1)
			) {
				throw new Error("重複候補の形式がAPI契約と一致しません");
			}
			return { ...member };
		});
		return { ...group, members };
	});
}

function isSafeFileName(fileName: string): boolean {
	return (
		typeof fileName === "string" &&
		Boolean(fileName) &&
		!/[\\/]/.test(fileName) &&
		normalizeRelativeSavePath(fileName) === fileName
	);
}

function isSafeDisplayText(value: string): boolean {
	return typeof value === "string" && Boolean(value.trim()) && !/(?:[a-z]:[\\/]|\\\\)/i.test(value);
}

function isSafeRelativeFilePath(relativePath: string, fileName: string): boolean {
	const normalized = normalizeRelativeSavePath(relativePath);
	return (
		Boolean(normalized) &&
		normalized === relativePath &&
		(normalized === fileName || normalized.endsWith(`\\${fileName}`))
	);
}

function cloneState(state: RuleIntegrityState): RuleIntegrityState {
	return {
		violations: {
			status: state.violations.status,
			data: state.violations.data.map((item) => ({ ...item })),
		},
		duplicates: {
			status: state.duplicates.status,
			data: state.duplicates.data.map((group) => ({
				...group,
				members: group.members.map((member) => ({ ...member })),
			})),
		},
	};
}
