import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
	AUTOMATIC_LOGIN_ATTEMPT_SESSION_KEY,
	EXPLICIT_LOGOUT_SESSION_KEY,
	EXPLICIT_LOGOUT_STORAGE_KEY,
	type LoginAutomationSessionStorage,
	handleMoodleLoginPage,
	setupMoodleLogoutTracking,
} from "../../apps/extension/src/entrypoints/content/loginAutomation";
import {
	SAVE_PANEL_OPEN_STATE_KEY,
	type SavePanelStateStorage,
} from "../../apps/extension/src/entrypoints/content/savePanelState";

const PAGE_URL = "https://moodle2026.wakayama-u.ac.jp/2026/course/view.php?id=1";
const LOGIN_PAGE_URL = "https://moodle2026.wakayama-u.ac.jp/2026/login/index_form.html";
const UNIVERSITY_LOGIN_LINK = `
	<a id="university-login" href="/2026/auth/oidc/">
		和歌山大学ID（ユーザ名@wakayama-u.ac.jp）でログインする
	</a>
`;

describe("Moodle再ログイン補助", () => {
	test("保存パネルを閉じる状態へ保存してから大学認証へ進む", async () => {
		const { document } = parseHTML(
			`<html><body class="notloggedin">${UNIVERSITY_LOGIN_LINK}</body></html>`,
		);
		const writes: boolean[] = [];
		let releaseWrite: (() => void) | undefined;
		const writePending = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		const storage = createPanelStorage(async (value) => {
			writes.push(value);
			await writePending;
		});
		let clickCount = 0;
		document.querySelector("#university-login")?.addEventListener("click", (event) => {
			event.preventDefault();
			clickCount += 1;
		});

		const handling = handleMoodleLoginPage({
			document,
			pageUrl: LOGIN_PAGE_URL,
			panelStateStorage: storage,
			sessionStorage: new MemorySessionStorage(),
		});

		await Promise.resolve();
		expect(writes).toEqual([false]);
		expect(clickCount).toBe(0);
		releaseWrite?.();
		expect(await handling).toBe("automatic-login-started");
		expect(clickCount).toBe(1);
	});

	test("通常の画面遷移ではパネル状態を変えず、教材内の大学認証URLも無視する", async () => {
		const { document } = parseHTML(
			`<html><body class="loggedin"><main>授業${UNIVERSITY_LOGIN_LINK}</main></body></html>`,
		);
		const writes: Record<string, unknown>[] = [];
		const storage: SavePanelStateStorage = {
			get: async () => ({}),
			set: async (items) => {
				writes.push(items);
			},
		};
		const sessionStorage = new MemorySessionStorage();
		let clickCount = 0;
		document.querySelector("#university-login")?.addEventListener("click", (event) => {
			event.preventDefault();
			clickCount += 1;
		});
		await setupMoodleLogoutTracking({
			document,
			pageUrl: PAGE_URL,
			panelStateStorage: storage,
			sessionStorage,
		});
		const result = await handleMoodleLoginPage({
			document,
			pageUrl: PAGE_URL,
			panelStateStorage: storage,
			sessionStorage,
		});

		expect(result).toBe("not-login-page");
		expect(writes).toEqual([]);
		expect(clickCount).toBe(0);
	});

	test("未ログイン表示の公開コースはログイン画面と誤判定しない", async () => {
		const { document } = parseHTML(
			`<html><body class="notloggedin"><main>${UNIVERSITY_LOGIN_LINK}</main></body></html>`,
		);
		const writes: Record<string, unknown>[] = [];
		let clickCount = 0;
		document.querySelector("#university-login")?.addEventListener("click", (event) => {
			event.preventDefault();
			clickCount += 1;
		});

		const result = await handleMoodleLoginPage({
			document,
			pageUrl: PAGE_URL,
			panelStateStorage: {
				get: async () => ({}),
				set: async (items) => {
					writes.push(items);
				},
			},
			sessionStorage: new MemorySessionStorage(),
		});

		expect(result).toBe("not-login-page");
		expect(writes).toEqual([]);
		expect(clickCount).toBe(0);
	});

	test("明示ログアウトではパネル状態を保ち、次のログイン画面でだけ閉じる", async () => {
		const sessionStorage = new MemorySessionStorage();
		sessionStorage.setItem(AUTOMATIC_LOGIN_ATTEMPT_SESSION_KEY, "true");
		sessionStorage.setItem(EXPLICIT_LOGOUT_SESSION_KEY, "previous-logout");
		const { document: authenticatedDocument, window } = parseHTML(`
			<html><body class="loggedin">
				<a id="logout" href="/2026/login/logout.php?sesskey=example"><span>ログアウト</span></a>
			</body></html>
		`);
		const stored: Record<string, unknown> = {
			[EXPLICIT_LOGOUT_STORAGE_KEY]: "previous-logout",
			[SAVE_PANEL_OPEN_STATE_KEY]: true,
		};
		const storage: SavePanelStateStorage = {
			get: async (key) => ({ [key]: stored[key] }),
			set: async (items) => {
				Object.assign(stored, items);
			},
		};
		let navigatedTo = "";
		await setupMoodleLogoutTracking({
			document: authenticatedDocument,
			pageUrl: PAGE_URL,
			panelStateStorage: storage,
			sessionStorage,
			createLogoutToken: () => "new-logout",
			navigate: (url) => {
				navigatedTo = url;
			},
		});
		expect(sessionStorage.getItem(AUTOMATIC_LOGIN_ATTEMPT_SESSION_KEY)).toBeNull();
		expect(stored[EXPLICIT_LOGOUT_STORAGE_KEY]).toBe(false);
		expect(stored[SAVE_PANEL_OPEN_STATE_KEY]).toBe(true);
		expect(sessionStorage.getItem(EXPLICIT_LOGOUT_SESSION_KEY)).toBeNull();

		authenticatedDocument
			.querySelector("#logout span")
			?.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
		await nextTask();
		expect(stored[EXPLICIT_LOGOUT_STORAGE_KEY]).toBe("new-logout");
		expect(stored[SAVE_PANEL_OPEN_STATE_KEY]).toBe(true);
		expect(sessionStorage.getItem(EXPLICIT_LOGOUT_SESSION_KEY)).toBe("new-logout");
		expect(navigatedTo).toContain("/2026/login/logout.php");

		const { document: loginDocument } = parseHTML(
			`<html><body>${UNIVERSITY_LOGIN_LINK}</body></html>`,
		);
		let clickCount = 0;
		loginDocument.querySelector("#university-login")?.addEventListener("click", (event) => {
			event.preventDefault();
			clickCount += 1;
		});
		const writes: boolean[] = [];
		const result = await handleMoodleLoginPage({
			document: loginDocument,
			pageUrl: LOGIN_PAGE_URL,
			panelStateStorage: {
				get: storage.get,
				set: async (items) => {
					Object.assign(stored, items);
					if (SAVE_PANEL_OPEN_STATE_KEY in items) {
						writes.push(items[SAVE_PANEL_OPEN_STATE_KEY] === true);
					}
				},
			},
			sessionStorage,
		});

		expect(result).toBe("automatic-login-suppressed");
		expect(writes).toEqual([false]);
		expect(clickCount).toBe(0);
	});

	test("抑止状態の解除が遅くても、その間のログアウトを取りこぼさない", async () => {
		const sessionStorage = new MemorySessionStorage();
		sessionStorage.setItem(EXPLICIT_LOGOUT_SESSION_KEY, "previous-logout");
		const { document, window } = parseHTML(`
			<html><body class="loggedin">
				<a id="logout" href="/2026/login/logout.php?sesskey=example">ログアウト</a>
			</body></html>
		`);
		const stored: Record<string, unknown> = {
			[EXPLICIT_LOGOUT_STORAGE_KEY]: "previous-logout",
			[SAVE_PANEL_OPEN_STATE_KEY]: true,
		};
		const writes: Record<string, unknown>[] = [];
		let releaseRead: (() => void) | undefined;
		const readPending = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		const storage: SavePanelStateStorage = {
			get: async (key) => {
				await readPending;
				return { [key]: stored[key] };
			},
			set: async (items) => {
				writes.push(items);
				Object.assign(stored, items);
			},
		};
		let navigatedTo = "";

		const setup = setupMoodleLogoutTracking({
			document,
			pageUrl: PAGE_URL,
			panelStateStorage: storage,
			sessionStorage,
			createLogoutToken: () => "new-logout",
			navigate: (url) => {
				navigatedTo = url;
			},
		});
		await Promise.resolve();
		document
			.querySelector("#logout")
			?.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));

		expect(navigatedTo).toContain("/2026/login/logout.php");
		expect(sessionStorage.getItem(EXPLICIT_LOGOUT_SESSION_KEY)).toBe("new-logout");
		releaseRead?.();
		await setup;
		await nextTask();
		expect(stored[EXPLICIT_LOGOUT_STORAGE_KEY]).toBe("new-logout");
		expect(stored[SAVE_PANEL_OPEN_STATE_KEY]).toBe(true);
		expect(writes).toEqual([
			{ [EXPLICIT_LOGOUT_STORAGE_KEY]: "new-logout" },
			{ [EXPLICIT_LOGOUT_STORAGE_KEY]: "new-logout" },
		]);
	});

	test("ログアウト抑止の永続化に失敗しても同じタブでは自動再ログインしない", async () => {
		const sessionStorage = new MemorySessionStorage();
		const { document: authenticatedDocument, window } = parseHTML(`
			<html><body class="loggedin">
				<a id="logout" href="/2026/login/logout.php?sesskey=example">ログアウト</a>
			</body></html>
		`);
		const stored: Record<string, unknown> = { [SAVE_PANEL_OPEN_STATE_KEY]: true };
		const errors: unknown[] = [];
		const storage: SavePanelStateStorage = {
			get: async (key) => ({ [key]: stored[key] }),
			set: async (items) => {
				if (EXPLICIT_LOGOUT_STORAGE_KEY in items) {
					throw new Error("persistent logout state unavailable");
				}
				Object.assign(stored, items);
			},
		};
		let navigatedTo = "";
		await setupMoodleLogoutTracking({
			document: authenticatedDocument,
			pageUrl: PAGE_URL,
			panelStateStorage: storage,
			sessionStorage,
			createLogoutToken: () => "failed-persistence",
			navigate: (url) => {
				navigatedTo = url;
			},
			onError: (error) => errors.push(error),
		});
		authenticatedDocument
			.querySelector("#logout")
			?.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
		await nextTask();

		expect(navigatedTo).toContain("/2026/login/logout.php");
		expect(stored[SAVE_PANEL_OPEN_STATE_KEY]).toBe(true);
		expect(errors).toHaveLength(1);

		const { document: loginDocument } = parseHTML(
			`<html><body>${UNIVERSITY_LOGIN_LINK}</body></html>`,
		);
		const result = await handleMoodleLoginPage({
			document: loginDocument,
			pageUrl: LOGIN_PAGE_URL,
			panelStateStorage: storage,
			sessionStorage,
			onError: (error) => errors.push(error),
		});

		expect(result).toBe("automatic-login-suppressed");
		expect(stored[SAVE_PANEL_OPEN_STATE_KEY]).toBe(false);
	});

	test("認証失敗でログイン画面へ戻っても自動操作を繰り返さない", async () => {
		const { document } = parseHTML(
			`<html><body class="notloggedin">${UNIVERSITY_LOGIN_LINK}</body></html>`,
		);
		const sessionStorage = new MemorySessionStorage();
		sessionStorage.setItem(AUTOMATIC_LOGIN_ATTEMPT_SESSION_KEY, "true");
		let clickCount = 0;
		document.querySelector("#university-login")?.addEventListener("click", (event) => {
			event.preventDefault();
			clickCount += 1;
		});

		const result = await handleMoodleLoginPage({
			document,
			pageUrl: LOGIN_PAGE_URL,
			panelStateStorage: createPanelStorage(async () => {}),
			sessionStorage,
		});

		expect(result).toBe("automatic-login-suppressed");
		expect(clickCount).toBe(0);
	});

	test("大学認証リンクがない、または複数候補なら手動ログインを残す", async () => {
		const noLink = parseHTML(`
			<html><body class="notloggedin">
				<form><input name="username"><input type="password"></form>
			</body></html>
		`).document;
		const ambiguous = parseHTML(`
			<html><body class="notloggedin">
				${UNIVERSITY_LOGIN_LINK}
				<a href="/2026/auth/oidc/?provider=second">
					和歌山大学ID（ユーザ名@wakayama-u.ac.jp）でログインする
				</a>
			</body></html>
		`).document;
		const writes: boolean[] = [];
		const storage = createPanelStorage(async (value) => {
			writes.push(value);
		});

		expect(
			await handleMoodleLoginPage({
				document: noLink,
				pageUrl: LOGIN_PAGE_URL,
				panelStateStorage: storage,
				sessionStorage: new MemorySessionStorage(),
			}),
		).toBe("manual-login");
		expect(
			await handleMoodleLoginPage({
				document: ambiguous,
				pageUrl: LOGIN_PAGE_URL,
				panelStateStorage: storage,
				sessionStorage: new MemorySessionStorage(),
			}),
		).toBe("manual-login");
		expect(writes).toEqual([false, false]);
	});

	test("保存状態の更新に失敗した場合は認証画面へ自動遷移しない", async () => {
		const { document } = parseHTML(
			`<html><body class="notloggedin">${UNIVERSITY_LOGIN_LINK}</body></html>`,
		);
		let clickCount = 0;
		document.querySelector("#university-login")?.addEventListener("click", (event) => {
			event.preventDefault();
			clickCount += 1;
		});
		const errors: unknown[] = [];

		const result = await handleMoodleLoginPage({
			document,
			pageUrl: LOGIN_PAGE_URL,
			panelStateStorage: createPanelStorage(async () => {
				throw new Error("storage unavailable");
			}),
			sessionStorage: new MemorySessionStorage(),
			onError: (error) => errors.push(error),
		});

		expect(result).toBe("state-reset-failed");
		expect(clickCount).toBe(0);
		expect(errors).toHaveLength(1);
	});

	test("外部URL・類似パス・異なる文言の候補は自動操作しない", async () => {
		const { document } = parseHTML(`
			<html><body class="notloggedin">
				<a id="external" href="https://example.com/2026/auth/oidc/">
					和歌山大学ID（ユーザ名@wakayama-u.ac.jp）でログインする
				</a>
				<a id="similar" href="/2026/auth/oidc/callback">
					和歌山大学ID（ユーザ名@wakayama-u.ac.jp）でログインする
				</a>
				<a id="wrong-label" href="/2026/auth/oidc/">学外者としてログインする</a>
			</body></html>
		`);
		let clickCount = 0;
		for (const link of document.querySelectorAll("a")) {
			link.addEventListener("click", (event) => {
				event.preventDefault();
				clickCount += 1;
			});
		}

		const result = await handleMoodleLoginPage({
			document,
			pageUrl: LOGIN_PAGE_URL,
			panelStateStorage: createPanelStorage(async () => {}),
			sessionStorage: new MemorySessionStorage(),
		});

		expect(result).toBe("manual-login");
		expect(clickCount).toBe(0);
	});

	test("タブ単位の試行状態を利用できない場合も自動操作しない", async () => {
		const { document } = parseHTML(
			`<html><body class="notloggedin">${UNIVERSITY_LOGIN_LINK}</body></html>`,
		);
		let clickCount = 0;
		document.querySelector("#university-login")?.addEventListener("click", (event) => {
			event.preventDefault();
			clickCount += 1;
		});
		const errors: unknown[] = [];
		const unavailableSessionStorage: LoginAutomationSessionStorage = {
			getItem: () => {
				throw new Error("session storage unavailable");
			},
			setItem: () => {
				throw new Error("session storage unavailable");
			},
			removeItem: () => {
				throw new Error("session storage unavailable");
			},
		};

		const result = await handleMoodleLoginPage({
			document,
			pageUrl: LOGIN_PAGE_URL,
			panelStateStorage: createPanelStorage(async () => {}),
			sessionStorage: unavailableSessionStorage,
			onError: (error) => errors.push(error),
		});

		expect(result).toBe("automatic-login-suppressed");
		expect(clickCount).toBe(0);
		expect(errors).toHaveLength(1);
	});

	test("大学認証とログアウトの遷移ページではFuzzy UIの起動対象にしない", async () => {
		const { document } = parseHTML('<html><body class="loggedin"></body></html>');
		const storage = createPanelStorage(async () => {});
		const sessionStorage = new MemorySessionStorage();

		expect(
			await handleMoodleLoginPage({
				document,
				pageUrl: "https://moodle2026.wakayama-u.ac.jp/2026/auth/oidc/",
				panelStateStorage: storage,
				sessionStorage,
			}),
		).toBe("authentication-transition");
		expect(
			await handleMoodleLoginPage({
				document,
				pageUrl: "https://moodle2026.wakayama-u.ac.jp/2026/login/logout.php",
				panelStateStorage: storage,
				sessionStorage,
			}),
		).toBe("logout-transition");
	});
});

function createPanelStorage(
	setState: (isOpen: boolean) => Promise<void> | void,
): SavePanelStateStorage {
	return {
		get: async () => ({}),
		set: async (items) => {
			await setState(items[SAVE_PANEL_OPEN_STATE_KEY] === true);
		},
	};
}

class MemorySessionStorage implements LoginAutomationSessionStorage {
	readonly #values = new Map<string, string>();

	getItem(key: string): string | null {
		return this.#values.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.#values.set(key, value);
	}

	removeItem(key: string): void {
		this.#values.delete(key);
	}
}

function nextTask(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}
