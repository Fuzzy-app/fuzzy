import type { AssignmentDetailProgress } from "../../lib/moodle/assignmentDetail";
import { nativeConnectionIssuePresentation } from "./userFacingError";

const STATUS_ID = "fuzzy-assignment-sync-status";
const STYLE_ID = "fuzzy-assignment-sync-status-style";
let dismissTimer: ReturnType<typeof setTimeout> | null = null;

export function showAssignmentDetailProgress(progress: AssignmentDetailProgress): void {
	if (progress.total === 0 && progress.skipped === 0) return;
	const detail =
		progress.skipped > 0
			? `確認対象 ${progress.total}件（上限を超えた${progress.skipped}件はMoodleで確認してください）`
			: `確認対象 ${progress.total}件`;
	renderStatus(
		"progress",
		"提出できるか確認しています",
		`${progress.completed} / ${progress.total}件完了・${detail}`,
	);
}

export function showAssignmentSyncSaving(): void {
	renderStatus(
		"progress",
		"課題・締切を更新しています",
		"確認した内容をあなたのPC上へ保存しています。",
	);
}

export function showAssignmentSyncComplete(progress: AssignmentDetailProgress): void {
	const unresolved = progress.unknown + progress.skipped;
	if (unresolved > 0) {
		renderStatus(
			"warning",
			"課題・締切を更新しました",
			`${unresolved}件は提出可否を確認できませんでした。必要な課題はMoodleで確認してください。`,
		);
		return;
	}
	renderStatus(
		"success",
		"課題・締切を更新しました",
		`${progress.completed}件の提出可否を確認しました。`,
	);
	scheduleDismiss();
}

export function showAssignmentSyncFailure(error?: unknown): void {
	const connectionIssue = nativeConnectionIssuePresentation(error);
	renderStatus(
		"error",
		connectionIssue?.title ?? "課題・締切を更新できませんでした",
		connectionIssue?.impact ??
			"Moodle上の閲覧は続けられます。ページを再読み込みして、もう一度お試しください。",
	);
}

function renderStatus(
	tone: "progress" | "success" | "warning" | "error",
	title: string,
	detail: string,
): void {
	if (dismissTimer) {
		clearTimeout(dismissTimer);
		dismissTimer = null;
	}
	injectStyle();
	const status = document.getElementById(STATUS_ID) ?? document.createElement("section");
	status.id = STATUS_ID;
	status.dataset.tone = tone;
	status.setAttribute("role", tone === "error" ? "alert" : "status");
	status.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
	status.replaceChildren();

	const marker = document.createElement("span");
	marker.className = "fuzzy-assignment-sync-marker";
	marker.setAttribute("aria-hidden", "true");
	marker.textContent =
		tone === "success" ? "✓" : tone === "warning" ? "!" : tone === "error" ? "×" : "…";
	const copy = document.createElement("div");
	const heading = document.createElement("strong");
	heading.textContent = title;
	const description = document.createElement("span");
	description.textContent = detail;
	copy.append(heading, description);
	status.append(marker, copy);
	if (!status.isConnected) document.body.append(status);
}

function injectStyle(): void {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
		#${STATUS_ID} {
			position: fixed;
			right: 20px;
			bottom: 20px;
			z-index: 2147483646;
			display: grid;
			grid-template-columns: auto minmax(0, 1fr);
			align-items: start;
			gap: 10px;
			box-sizing: border-box;
			width: min(360px, calc(100vw - 40px));
			border: 1px solid var(--fuzzy-color-border);
			border-left: 4px solid var(--fuzzy-color-info);
			border-radius: 12px;
			background: var(--fuzzy-color-surface);
			padding: 12px;
			color: var(--fuzzy-color-text);
			box-shadow: var(--fuzzy-shadow-floating);
			font-family: var(--fuzzy-font-family);
		}
		#${STATUS_ID}[data-tone="success"] { border-left-color: var(--fuzzy-color-success); }
		#${STATUS_ID}[data-tone="warning"] { border-left-color: var(--fuzzy-color-warning); }
		#${STATUS_ID}[data-tone="error"] { border-left-color: var(--fuzzy-color-danger); }
		#${STATUS_ID} div { display: grid; gap: 3px; }
		#${STATUS_ID} strong { font-size: 13px; line-height: 1.4; }
		#${STATUS_ID} span { font-size: 11px; line-height: 1.5; }
		.fuzzy-assignment-sync-marker {
			display: inline-grid;
			place-items: center;
			width: 22px;
			height: 22px;
			border-radius: 50%;
			background: var(--fuzzy-color-info-soft);
			color: var(--fuzzy-color-info);
			font-weight: 900;
		}
		#${STATUS_ID}[data-tone="success"] .fuzzy-assignment-sync-marker {
			background: var(--fuzzy-color-success-soft);
			color: var(--fuzzy-color-success-strong);
		}
		#${STATUS_ID}[data-tone="warning"] .fuzzy-assignment-sync-marker {
			background: var(--fuzzy-color-warning-soft);
			color: var(--fuzzy-color-warning);
		}
		#${STATUS_ID}[data-tone="error"] .fuzzy-assignment-sync-marker {
			background: var(--fuzzy-color-danger-soft);
			color: var(--fuzzy-color-danger);
		}
	`;
	document.head.append(style);
}

function scheduleDismiss(): void {
	dismissTimer = setTimeout(() => {
		document.getElementById(STATUS_ID)?.remove();
		dismissTimer = null;
	}, 4_000);
}
