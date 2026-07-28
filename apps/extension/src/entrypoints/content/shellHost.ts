import { SHELL_DRAWER_BUTTON_ID } from "./shellIds";

export function findNavHost(): HTMLElement | null {
	const selectors = [
		".primary-navigation .navigation .nav.more-nav",
		".primary-navigation .moremenu",
		"nav .nav.more-nav",
		"header nav ul",
	];

	for (const selector of selectors) {
		const target = document.querySelector<HTMLElement>(selector);
		if (target) return target;
	}

	return null;
}

export function findMainHost(): HTMLElement | null {
	const selectors = [
		"#region-main",
		"main[role='main']",
		"#page-content #region-main-box",
		"#page-content",
		".main-inner",
	];

	for (const selector of selectors) {
		const target = document.querySelector<HTMLElement>(selector);
		if (target) return target;
	}

	return null;
}

export function insertNavRoot(navHost: HTMLElement, root: HTMLElement): void {
	const moreItem = Array.from(navHost.children).find((child) => {
		if (!(child instanceof HTMLElement)) return false;
		const text = child.textContent?.trim() ?? "";
		return text.includes("さらに") || text.includes("More");
	});

	if (moreItem) {
		navHost.insertBefore(root, moreItem);
	} else {
		navHost.append(root);
	}

	window.dispatchEvent(new Event("resize"));
}

function findDrawerMyCoursesLink(): HTMLAnchorElement | null {
	return (
		Array.from(document.querySelectorAll<HTMLAnchorElement>("a.list-group-item")).find((link) => {
			const href = link.getAttribute("href") ?? "";
			const text = link.textContent?.trim() ?? "";
			return (
				(href.includes("/my/courses.php") || text === "マイコース" || text === "My courses") &&
				!link.classList.contains("sr-only") &&
				!link.classList.contains("skip")
			);
		}) ?? null
	);
}

export function upsertDrawerButton(): HTMLAnchorElement | null {
	const existing = document.getElementById(SHELL_DRAWER_BUTTON_ID);
	if (existing instanceof HTMLAnchorElement) return existing;

	const myCoursesLink = findDrawerMyCoursesLink();
	if (!myCoursesLink) return null;

	const button = document.createElement("a");
	button.id = SHELL_DRAWER_BUTTON_ID;
	button.href = "#";
	button.className = "list-group-item list-group-item-action fuzzy-drawer-button";
	button.textContent = "Fuzzy";
	myCoursesLink.insertAdjacentElement("afterend", button);
	return button;
}

export function getShellTopOffset(navHost: HTMLElement): number {
	const candidates = [
		navHost.closest<HTMLElement>("header"),
		navHost.closest<HTMLElement>(".primary-navigation"),
		navHost.closest<HTMLElement>(".secondary-navigation"),
		navHost.closest<HTMLElement>(".moremenu"),
		document.querySelector<HTMLElement>("header[role='banner']"),
		document.querySelector<HTMLElement>(".navbar"),
		document.querySelector<HTMLElement>(".primary-navigation"),
		document.querySelector<HTMLElement>(".secondary-navigation"),
		document.querySelector<HTMLElement>(".tertiary-navigation"),
		document.querySelector<HTMLElement>(".nav-tabs"),
		document.querySelector<HTMLElement>(".tabs"),
		document.querySelector<HTMLElement>(".moremenu"),
		document.querySelector<HTMLElement>(".secondarymoremenu"),
		document.querySelector<HTMLElement>("#page-header"),
		document.querySelector<HTMLElement>(".page-header-headings"),
	];

	const bottoms = candidates
		.filter((element): element is HTMLElement => element !== null)
		.map((element) => element.getBoundingClientRect().bottom)
		.filter((bottom) => Number.isFinite(bottom) && bottom > 0);

	if (bottoms.length === 0) {
		return Math.max(0, Math.round(navHost.getBoundingClientRect().bottom));
	}

	return Math.max(0, Math.round(Math.max(...bottoms)));
}
