import {
	ApiError,
	type DuplicateGroupListItem,
	type ExcludedFolder,
	type RuleViolationListItem,
} from "@fuzzy/shared";
import { createBackgroundRuleManagementApi } from "./backgroundApi";
import type {
	RuleManagementApi,
	RuleManagementState,
	RuleSaveTarget,
	RuleSet,
	UpdateCourseRuleOverrideRequest,
	UpdateExcludedFoldersRequest,
	UpdateGlobalRuleRequest,
} from "./types";

export type RuleManagementStateListener = (state: Readonly<RuleManagementState>) => void;

const initialState: RuleManagementState = {
	status: "idle",
	rules: null,
	saving: null,
	error: null,
	lastSavedTarget: null,
	lastSavedAt: null,
	mutationRevision: 0,
};

/**
 * ルール画面と後続の警告表示で共有できる状態ストア。
 * API の native 化後もコンストラクターへアダプターを渡すだけで UI を維持できる。
 */
export class RuleManagementStore {
	readonly #api: RuleManagementApi;
	readonly #listeners = new Set<RuleManagementStateListener>();
	#state: RuleManagementState = { ...initialState };

	constructor(api: RuleManagementApi) {
		this.#api = api;
	}

	get mode(): RuleManagementApi["mode"] {
		return this.#api.mode;
	}

	get snapshot(): Readonly<RuleManagementState> {
		return cloneState(this.#state);
	}

	subscribe(listener: RuleManagementStateListener): () => void {
		this.#listeners.add(listener);
		listener(this.snapshot);
		return () => this.#listeners.delete(listener);
	}

	async load(): Promise<RuleSet> {
		this.#setState({ status: "loading", error: null });
		try {
			const rules = await this.#api.getRules();
			this.#setState({ status: "ready", rules, error: null });
			return cloneRuleSet(rules);
		} catch (error) {
			this.#setState({ status: "error", error: errorMessage(error) });
			throw error;
		}
	}

	async updateGlobalRule(request: UpdateGlobalRuleRequest): Promise<RuleSet> {
		return this.#save({ scope: "global" }, () => this.#api.updateGlobalRule(request));
	}

	async updateCourseRuleOverride(request: UpdateCourseRuleOverrideRequest): Promise<RuleSet> {
		return this.#save({ scope: "course", courseId: request.courseId }, () =>
			this.#api.updateCourseRuleOverride(request),
		);
	}

	async clearCourseRuleOverride(courseId: number): Promise<RuleSet> {
		return this.#save({ scope: "course", courseId }, () =>
			this.#api.clearCourseRuleOverride(courseId),
		);
	}

	getExcludedFolders(courseId?: number): Promise<ExcludedFolder[]> {
		return this.#api.getExcludedFolders(courseId);
	}

	updateExcludedFolders(request: UpdateExcludedFoldersRequest): Promise<ExcludedFolder[]> {
		return this.#api.updateExcludedFolders(request);
	}

	getRuleViolations(): Promise<RuleViolationListItem[]> {
		return this.#api.getRuleViolations();
	}

	getDuplicateGroups(): Promise<DuplicateGroupListItem[]> {
		return this.#api.getDuplicateGroups();
	}

	async #save(target: RuleSaveTarget, save: () => Promise<unknown>): Promise<RuleSet> {
		if (this.#state.saving) throw new Error("別のルールを保存中です。");
		this.#setState({ saving: target, error: null });

		try {
			await save();
			this.#setState({ mutationRevision: this.#state.mutationRevision + 1 });
			const rules = await this.#api.getRules();
			this.#setState({
				status: "ready",
				rules,
				saving: null,
				error: null,
				lastSavedTarget: target,
				lastSavedAt: new Date().toISOString(),
			});
			return cloneRuleSet(rules);
		} catch (error) {
			this.#setState({
				status: this.#state.rules ? "ready" : "error",
				saving: null,
				error: errorMessage(error),
			});
			throw error;
		}
	}

	#setState(patch: Partial<RuleManagementState>): void {
		this.#state = { ...this.#state, ...patch };
		for (const listener of this.#listeners) listener(this.snapshot);
	}
}

export function createRuleManagementStore(): RuleManagementStore {
	return new RuleManagementStore(
		createBackgroundRuleManagementApi() ?? createUnavailableRuleManagementApi(),
	);
}

function createUnavailableRuleManagementApi(): RuleManagementApi {
	const unavailable = (): Promise<never> =>
		Promise.reject(
			new ApiError(
				"NO_NATIVE_HOST",
				"拡張機能のbackgroundへ接続できません。ページを再読み込みしてから再試行してください。",
			),
		);
	return {
		mode: "native",
		getRules: unavailable,
		updateGlobalRule: unavailable,
		updateCourseRuleOverride: unavailable,
		clearCourseRuleOverride: unavailable,
		getExcludedFolders: unavailable,
		updateExcludedFolders: unavailable,
		getRuleViolations: unavailable,
		getDuplicateGroups: unavailable,
	};
}

function cloneState(state: RuleManagementState): RuleManagementState {
	return {
		...state,
		rules: state.rules ? cloneRuleSet(state.rules) : null,
		saving: state.saving ? { ...state.saving } : null,
		lastSavedTarget: state.lastSavedTarget ? { ...state.lastSavedTarget } : null,
	};
}

function cloneRuleSet(rules: RuleSet): RuleSet {
	return {
		globalPatternTemplate: rules.globalPatternTemplate,
		courseOverrides: rules.courseOverrides.map((override) => ({ ...override })),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "ルールを更新できませんでした。";
}
