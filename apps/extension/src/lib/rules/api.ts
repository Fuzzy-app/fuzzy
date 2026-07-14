import { MockApiClient } from "@fuzzy/shared";
import type {
	CourseRuleOverride,
	CourseRuleOverrideInput,
	RuleManagementApi,
	RuleSet,
	RuleUpdateResult,
	UpdateCourseRuleOverrideRequest,
	UpdateGlobalRuleRequest,
} from "./types";

export const RULE_MANAGEMENT_STORAGE_KEY = "fuzzy.extension.ruleManagement";

const RULE_STORAGE_VERSION = 1;

interface StoredRulesV1 {
	version: typeof RULE_STORAGE_VERSION;
	revision: number;
	updatedAt: string | null;
	rules: RuleSet;
}

export interface RuleManagementStorage {
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
}

export interface LocalRuleManagementApiOptions {
	storage?: RuleManagementStorage;
	seedRules?: () => Promise<unknown>;
	now?: () => Date;
}

export class RuleManagementApiError extends Error {
	constructor(
		public readonly code: "INVALID_RULE" | "UNSUPPORTED_STORAGE_VERSION",
		message: string,
	) {
		super(message);
		this.name = "RuleManagementApiError";
	}
}

/** Bun テストと browser.storage.local 非対応環境で利用する同一プロセス内ストレージ。 */
export class MemoryRuleManagementStorage implements RuleManagementStorage {
	readonly #values = new Map<string, unknown>();

	async get(key: string): Promise<unknown> {
		return cloneUnknown(this.#values.get(key));
	}

	async set(key: string, value: unknown): Promise<void> {
		this.#values.set(key, cloneUnknown(value));
	}
}

const fallbackStorage = new MemoryRuleManagementStorage();

/**
 * native-host 未接続中のルール管理 API。
 * 初回だけ共有 MockApiClient#getRules のサンプルを取り込み、以降は拡張機能内に保存する。
 */
export class LocalRuleManagementApi implements RuleManagementApi {
	readonly mode = "local-mock" as const;

	readonly #storage: RuleManagementStorage;
	readonly #seedRules: () => Promise<unknown>;
	readonly #now: () => Date;
	#mutationQueue: Promise<void> = Promise.resolve();

	constructor(options: LocalRuleManagementApiOptions = {}) {
		this.#storage = options.storage ?? createDefaultStorage();
		this.#seedRules = options.seedRules ?? (() => new MockApiClient().getRules());
		this.#now = options.now ?? (() => new Date());
	}

	async getRules(): Promise<RuleSet> {
		return cloneRuleSet((await this.#readStoredRules()).rules);
	}

	async updateGlobalRule(request: UpdateGlobalRuleRequest): Promise<RuleUpdateResult> {
		const patternTemplate = normalizePatternTemplate(
			request.patternTemplate,
			"グローバルルールを入力してください。",
		);

		return this.#enqueueMutation(async (stored) => {
			for (const override of stored.rules.courseOverrides) {
				assertCourseOverrideConsistency(override, patternTemplate);
			}

			return {
				...stored,
				rules: {
					...stored.rules,
					globalPatternTemplate: patternTemplate,
				},
			};
		});
	}

	async updateCourseRuleOverride(
		request: UpdateCourseRuleOverrideRequest,
	): Promise<RuleUpdateResult> {
		if (!Number.isInteger(request.courseId) || request.courseId <= 0) {
			throw new RuleManagementApiError("INVALID_RULE", "コースを選択してください。");
		}

		const override = normalizeCourseOverride(request.override);
		return this.#enqueueMutation(async (stored) => {
			assertCourseOverrideConsistency(override, stored.rules.globalPatternTemplate);
			const nextOverride: CourseRuleOverride = {
				courseId: request.courseId,
				...override,
			};
			const existingIndex = stored.rules.courseOverrides.findIndex(
				(candidate) => candidate.courseId === request.courseId,
			);
			const courseOverrides = stored.rules.courseOverrides.map((candidate) => ({ ...candidate }));

			if (existingIndex === -1) {
				courseOverrides.push(nextOverride);
			} else {
				courseOverrides[existingIndex] = nextOverride;
			}

			return {
				...stored,
				rules: {
					...stored.rules,
					courseOverrides,
				},
			};
		});
	}

	async #enqueueMutation(
		mutate: (stored: StoredRulesV1) => Promise<StoredRulesV1>,
	): Promise<RuleUpdateResult> {
		const operation = this.#mutationQueue.then(async () => {
			const stored = await this.#readStoredRules();
			const next = await mutate(stored);
			await this.#storage.set(RULE_MANAGEMENT_STORAGE_KEY, {
				...next,
				version: RULE_STORAGE_VERSION,
				revision: stored.revision + 1,
				updatedAt: this.#now().toISOString(),
			} satisfies StoredRulesV1);
		});

		this.#mutationQueue = operation.catch(() => undefined);
		await operation;
		return { ok: true };
	}

	async #readStoredRules(): Promise<StoredRulesV1> {
		const value = await this.#storage.get(RULE_MANAGEMENT_STORAGE_KEY);
		const stored = parseStoredRules(value);

		if (stored.kind === "valid") return stored.value;
		if (stored.kind === "unsupported") {
			throw new RuleManagementApiError(
				"UNSUPPORTED_STORAGE_VERSION",
				"保存済みルールは新しいバージョンで作成されています。",
			);
		}

		const seed = parseRuleSet(await this.#seedRules());
		if (!seed) {
			throw new RuleManagementApiError("INVALID_RULE", "初期ルールを読み込めませんでした。");
		}

		const initial: StoredRulesV1 = {
			version: RULE_STORAGE_VERSION,
			revision: 0,
			updatedAt: null,
			rules: seed,
		};
		await this.#storage.set(RULE_MANAGEMENT_STORAGE_KEY, initial);
		return initial;
	}
}

export function createLocalRuleManagementApi(
	options: LocalRuleManagementApiOptions = {},
): RuleManagementApi {
	return new LocalRuleManagementApi(options);
}

function normalizeCourseOverride(override: CourseRuleOverrideInput): CourseRuleOverrideInput {
	if (!override || typeof override !== "object") {
		throw new RuleManagementApiError("INVALID_RULE", "コース別例外を入力してください。");
	}
	if (typeof override.courseName !== "string") {
		throw new RuleManagementApiError("INVALID_RULE", "コース名を入力してください。");
	}
	if (typeof override.splitBySection !== "boolean") {
		throw new RuleManagementApiError("INVALID_RULE", "回ごとの整理方法を選択してください。");
	}
	if (override.patternTemplate !== null && typeof override.patternTemplate !== "string") {
		throw new RuleManagementApiError("INVALID_RULE", "例外ルールを入力してください。");
	}
	if (override.note !== null && typeof override.note !== "string") {
		throw new RuleManagementApiError("INVALID_RULE", "メモを文字列で入力してください。");
	}

	const courseName = normalizeRequiredText(override.courseName, "コース名を入力してください。");
	const patternTemplate =
		override.patternTemplate === null
			? null
			: normalizePatternTemplate(override.patternTemplate, "例外ルールを入力してください。");
	const note = override.note?.trim() || null;

	return {
		courseName,
		splitBySection: override.splitBySection,
		patternTemplate,
		note,
	};
}

function normalizeRequiredText(value: string, message: string): string {
	if (typeof value !== "string") throw new RuleManagementApiError("INVALID_RULE", message);
	const normalized = value.trim();
	if (!normalized) throw new RuleManagementApiError("INVALID_RULE", message);
	return normalized;
}

function normalizePatternTemplate(value: string, message: string): string {
	const normalized = normalizeRequiredText(value, message);
	if (!normalized.includes("{course}")) {
		throw new RuleManagementApiError(
			"INVALID_RULE",
			"テンプレートには {course} を含めてください。",
		);
	}
	return normalized;
}

function assertCourseOverrideConsistency(
	override: CourseRuleOverrideInput,
	globalPatternTemplate: string,
): void {
	const effectivePattern = override.patternTemplate ?? globalPatternTemplate;
	if (!effectivePattern.includes("{course}")) {
		throw new RuleManagementApiError(
			"INVALID_RULE",
			"テンプレートには {course} を含めてください。",
		);
	}
	if (!override.splitBySection && effectivePattern.includes("{section}")) {
		throw new RuleManagementApiError(
			"INVALID_RULE",
			"回ごとに分けない場合はテンプレートから {section} を外してください。",
		);
	}
	if (override.splitBySection && !effectivePattern.includes("{section}")) {
		throw new RuleManagementApiError(
			"INVALID_RULE",
			"回ごとに分ける場合はテンプレートに {section} を含めてください。",
		);
	}
}

type ParsedStoredRules =
	| { kind: "valid"; value: StoredRulesV1 }
	| { kind: "invalid" }
	| { kind: "unsupported" };

function parseStoredRules(value: unknown): ParsedStoredRules {
	if (!isRecord(value)) return { kind: "invalid" };
	if (typeof value.version === "number" && value.version !== RULE_STORAGE_VERSION) {
		return { kind: "unsupported" };
	}
	if (value.version !== RULE_STORAGE_VERSION) return { kind: "invalid" };
	if (!Number.isInteger(value.revision) || (value.revision as number) < 0) {
		return { kind: "invalid" };
	}
	if (value.updatedAt !== null && typeof value.updatedAt !== "string") {
		return { kind: "invalid" };
	}

	const rules = parseRuleSet(value.rules);
	if (!rules) return { kind: "invalid" };

	return {
		kind: "valid",
		value: {
			version: RULE_STORAGE_VERSION,
			revision: value.revision as number,
			updatedAt: value.updatedAt as string | null,
			rules,
		},
	};
}

function parseRuleSet(value: unknown): RuleSet | null {
	if (!isRecord(value) || typeof value.globalPatternTemplate !== "string") return null;
	const globalPatternTemplate = value.globalPatternTemplate.trim();
	if (
		!globalPatternTemplate ||
		!globalPatternTemplate.includes("{course}") ||
		!Array.isArray(value.courseOverrides)
	) {
		return null;
	}

	const courseOverrides: CourseRuleOverride[] = [];
	const seenCourseIds = new Set<number>();
	for (const candidate of value.courseOverrides) {
		const parsed = parseCourseOverride(candidate);
		if (!parsed || seenCourseIds.has(parsed.courseId)) return null;
		const effectivePattern = parsed.patternTemplate ?? globalPatternTemplate;
		if (!effectivePattern.includes("{course}")) return null;
		if (!parsed.splitBySection && effectivePattern.includes("{section}")) return null;
		if (parsed.splitBySection && !effectivePattern.includes("{section}")) return null;
		seenCourseIds.add(parsed.courseId);
		courseOverrides.push(parsed);
	}

	return { globalPatternTemplate, courseOverrides };
}

function parseCourseOverride(value: unknown): CourseRuleOverride | null {
	if (!isRecord(value)) return null;
	if (!Number.isInteger(value.courseId) || (value.courseId as number) <= 0) return null;
	if (typeof value.courseName !== "string" || !value.courseName.trim()) return null;
	if (typeof value.splitBySection !== "boolean") return null;
	if (value.patternTemplate !== null && typeof value.patternTemplate !== "string") return null;
	if (typeof value.patternTemplate === "string" && !value.patternTemplate.trim()) return null;
	if (value.note !== null && typeof value.note !== "string") return null;

	return {
		courseId: value.courseId as number,
		courseName: value.courseName.trim(),
		splitBySection: value.splitBySection,
		patternTemplate:
			typeof value.patternTemplate === "string" ? value.patternTemplate.trim() : null,
		note: typeof value.note === "string" ? value.note.trim() || null : null,
	};
}

function cloneRuleSet(rules: RuleSet): RuleSet {
	return {
		globalPatternTemplate: rules.globalPatternTemplate,
		courseOverrides: rules.courseOverrides.map((override) => ({ ...override })),
	};
}

function cloneUnknown<T>(value: T): T {
	return value === undefined ? value : structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface BrowserStorageAreaLike {
	get(key: string): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
}

interface ChromeStorageAreaLike {
	get(key: string, callback: (items: Record<string, unknown>) => void): void;
	set(items: Record<string, unknown>, callback: () => void): void;
}

interface ChromeRuntimeLike {
	lastError?: { message?: string };
}

function createDefaultStorage(): RuleManagementStorage {
	const extensionBrowser = globalThis as typeof globalThis & {
		browser?: { storage?: { local?: BrowserStorageAreaLike } };
		chrome?: {
			storage?: { local?: ChromeStorageAreaLike };
			runtime?: ChromeRuntimeLike;
		};
	};
	const browserArea = extensionBrowser.browser?.storage?.local;
	if (browserArea) {
		return {
			async get(key: string): Promise<unknown> {
				const stored = await browserArea.get(key);
				return stored[key];
			},
			async set(key: string, value: unknown): Promise<void> {
				await browserArea.set({ [key]: value });
			},
		};
	}

	const chromeArea = extensionBrowser.chrome?.storage?.local;
	if (chromeArea) return createChromeStorage(chromeArea, extensionBrowser.chrome?.runtime);
	return fallbackStorage;
}

function createChromeStorage(
	area: ChromeStorageAreaLike,
	runtime: ChromeRuntimeLike | undefined,
): RuleManagementStorage {
	return {
		get(key: string): Promise<unknown> {
			return new Promise((resolve, reject) => {
				area.get(key, (stored) => {
					const message = runtime?.lastError?.message;
					if (message) reject(new Error(message));
					else resolve(stored[key]);
				});
			});
		},
		set(key: string, value: unknown): Promise<void> {
			return new Promise((resolve, reject) => {
				area.set({ [key]: value }, () => {
					const message = runtime?.lastError?.message;
					if (message) reject(new Error(message));
					else resolve();
				});
			});
		},
	};
}
