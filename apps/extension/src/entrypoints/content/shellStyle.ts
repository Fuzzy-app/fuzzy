import { SHELL_PAGE_ID, SHELL_ROOT_ID, SHELL_STYLE_ID } from "./shellIds";

export function ensureShellStyle(): void {
	if (document.getElementById(SHELL_STYLE_ID)) return;

	const style = document.createElement("style");
	style.id = SHELL_STYLE_ID;
	style.textContent = `
		body.fuzzy-shell-open {
			overflow: hidden;
			overflow-x: hidden;
			overscroll-behavior: none;
		}

		/* 暗幕はFuzzy画面の上に置くが、通知・メッセージ本体は暗幕より
		   さらに前へ出す。Moodle側の既定の半透明指定もここで打ち消す。 */
		body.fuzzy-shell-open .drawer-backdrop,
		body.fuzzy-shell-open .modal-backdrop {
			z-index: 2147483001 !important;
		}

		body.fuzzy-shell-open .popover-region-container,
		body.fuzzy-shell-open [data-region="message-drawer"],
		body.fuzzy-shell-open .drawer,
		body.fuzzy-shell-open .modal {
			z-index: 2147483003 !important;
			background-color: #fff !important;
			opacity: 1 !important;
			filter: none !important;
		}

		/* Moodle本文側のページ見出しはFuzzyと重ねない。右上の通知・メッセージ・
		   ユーザーメニューは下の.navbarに属するため、ここを隠しても操作できる。 */
		body.fuzzy-shell-open #page-header,
		body.fuzzy-shell-open #page-navbar {
			display: none !important;
		}

		/* 通知ポップオーバーの親stacking contextだけをFuzzyより前へ出す。 */
		body.fuzzy-shell-open .navbar {
			position: relative;
			z-index: 2147483002 !important;
		}

		#${SHELL_ROOT_ID} {
			margin-left: 8px;
		}

		.fuzzy-nav-button {
			display: inline-flex;
			align-items: center;
			gap: 10px;
			border-bottom: 3px solid transparent;
			padding: 12px 16px 10px;
			font-family: var(--fuzzy-font-family);
			font-weight: 700;
		}

		.fuzzy-nav-button:hover,
		.fuzzy-nav-button.is-active {
			border-bottom-color: var(--fuzzy-color-primary);
		}

		.fuzzy-nav-mark {
			display: block;
			flex: 0 0 auto;
			width: 28px;
			height: 28px;
			border-radius: 10px;
			object-fit: cover;
		}

		#${SHELL_PAGE_ID} {
			position: fixed;
			left: 0;
			right: 0;
			bottom: 0;
			width: 100vw;
			max-width: 100vw;
			z-index: 2147483000;
			isolation: isolate;
			display: grid;
			grid-template-columns: 180px minmax(0, 1fr);
			min-height: 0;
			overflow: hidden;
			background:
				var(--fuzzy-brand-atmosphere),
				linear-gradient(
					180deg,
					var(--fuzzy-color-primary-soft) 0%,
					var(--fuzzy-color-page) 100%
				);
			background-color: var(--fuzzy-color-page);
			color: var(--fuzzy-color-text-strong);
			font-family: var(--fuzzy-font-family);
		}

		.fuzzy-sidebar {
			display: grid;
			grid-template-rows: auto 1fr auto;
			gap: 24px;
			padding: 18px 12px;
			background: var(--fuzzy-color-sidebar);
			color: var(--fuzzy-color-text-inverse);
		}

		.fuzzy-brand {
			display: flex;
			align-items: center;
			gap: 10px;
			font-size: 1rem;
			font-weight: 800;
		}

		.fuzzy-brand-mark {
			display: block;
			flex: 0 0 auto;
			width: 28px;
			height: 28px;
			border-radius: 8px;
			object-fit: cover;
		}

		.fuzzy-side-nav {
			display: grid;
			align-content: start;
			gap: 8px;
		}

		.fuzzy-side-link {
			display: flex;
			align-items: center;
			gap: 10px;
			border: 0;
			border-radius: 10px;
			padding: 12px 10px;
			background: transparent;
			color: var(--fuzzy-color-sidebar-text);
			font: inherit;
			font-size: var(--fuzzy-font-size-small);
			font-weight: 700;
			text-align: left;
			cursor: pointer;
		}

		.fuzzy-side-link.is-active {
			background: var(--fuzzy-color-sidebar-active);
			color: var(--fuzzy-color-surface);
		}

		.fuzzy-side-label {
			min-width: 0;
			flex: 1 1 auto;
		}

		.fuzzy-side-dot {
			width: 12px;
			height: 12px;
			border-radius: 4px;
			background: var(--fuzzy-color-sidebar-icon);
		}

		.fuzzy-side-link.is-active .fuzzy-side-dot {
			background: var(--fuzzy-brand-gradient);
		}

		.fuzzy-content {
			display: grid;
			grid-template-rows: auto 1fr;
			gap: 12px;
			min-width: 0;
			min-height: 0;
			padding: 24px 28px 32px;
			overflow-x: hidden;
			overflow-y: auto;
			overscroll-behavior: contain;
		}

		.fuzzy-topbar {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 16px;
			width: 100%;
			max-width: 1320px;
			margin: 0 auto;
		}

		.fuzzy-top-status {
			margin: 0;
			border-radius: 999px;
			padding: 6px 12px;
			background: var(--fuzzy-color-surface-muted);
			color: var(--fuzzy-color-text-muted);
			font-size: var(--fuzzy-font-size-caption);
			font-weight: 800;
		}

		.fuzzy-top-status[data-mode="checking"] {
			background: var(--fuzzy-color-surface-muted);
			color: var(--fuzzy-color-text-muted);
		}

		.fuzzy-top-status[data-mode="mock"] {
			background: var(--fuzzy-color-info-soft);
			color: var(--fuzzy-color-info);
		}

		.fuzzy-top-status[data-mode="native"] {
			background: var(--fuzzy-color-success-soft);
			color: var(--fuzzy-color-success-strong);
		}

		.fuzzy-close-button {
			border: 0;
			border-radius: 10px;
			padding: 10px 14px;
			background: var(--fuzzy-color-surface);
			color: var(--fuzzy-color-text-secondary);
			font: inherit;
			font-size: var(--fuzzy-font-size-small);
			font-weight: 700;
			cursor: pointer;
		}

		.fuzzy-screen {
			display: grid;
			gap: 18px;
		}

		.fuzzy-main {
			min-width: 0;
			max-width: 1320px;
			width: 100%;
			margin: 0 auto;
		}

		.fuzzy-screen-header {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 20px;
		}

		.fuzzy-screen-kicker,
		.fuzzy-section-label {
			margin: 0 0 8px;
			color: var(--fuzzy-color-text-secondary);
			font-size: var(--fuzzy-font-size-caption);
			font-weight: 800;
		}

		.fuzzy-screen-header h1,
		.fuzzy-note-copy,
		.fuzzy-empty p,
		.fuzzy-search-meta p {
			margin: 0;
		}

		.fuzzy-screen-header h1 {
			font-size: 2rem;
			font-weight: 900;
			line-height: 1.12;
		}

		.fuzzy-search-panel,
		.fuzzy-search-results,
		.fuzzy-search-note,
		.fuzzy-placeholder,
		.fuzzy-empty {
			padding: 16px;
			border-radius: 14px;
			background: var(--fuzzy-color-surface);
			box-shadow: var(--fuzzy-shadow-card);
		}

		.fuzzy-search-tabs {
			display: flex;
			gap: 10px;
			margin-bottom: 12px;
		}

		.fuzzy-chip {
			border: 0;
			border-radius: 10px;
			padding: 8px 14px;
			background: var(--fuzzy-color-surface-muted);
			color: var(--fuzzy-color-text-secondary);
			font: inherit;
			font-size: 0.8rem;
			font-weight: 800;
		}

		.fuzzy-chip.is-active {
			background: var(--fuzzy-color-surface);
			color: var(--fuzzy-color-text-strong);
			box-shadow: inset 0 0 0 1px var(--fuzzy-color-border);
		}

		.fuzzy-search-form {
			display: grid;
			grid-template-columns: 1fr auto;
			gap: 12px;
			align-items: center;
		}

		.fuzzy-search-scope {
			display: grid;
			grid-template-columns: minmax(180px, 0.8fr) minmax(240px, 1.2fr);
			gap: 10px;
			margin-top: 10px;
		}

		.fuzzy-search-scope-field {
			display: grid;
			gap: 4px;
			color: var(--fuzzy-color-text-muted);
			font-size: 0.74rem;
		}

		.fuzzy-search-scope-field select,
		.fuzzy-search-scope-field input,
		.fuzzy-course-tree,
		.fuzzy-search-course-tree {
			min-width: 0;
			border: 1px solid var(--fuzzy-color-border);
			border-radius: 8px;
			padding: 8px 10px;
			background: var(--fuzzy-color-surface);
			color: var(--fuzzy-color-text);
			font: inherit;
		}

		.fuzzy-course-tree,
		.fuzzy-search-course-tree {
			display: grid;
			gap: 5px;
			max-height: 180px;
			overflow-y: auto;
			padding: 5px;
			border: 1px solid var(--fuzzy-color-border);
			border-radius: 8px;
			background: var(--fuzzy-color-surface);
		}

		.fuzzy-course-tree-hint {
			margin: 2px 4px 4px;
			color: var(--fuzzy-color-text-muted);
			font-size: 0.7rem;
			line-height: 1.5;
		}

		.fuzzy-course-tree-group {
			border-radius: 6px;
			background: var(--fuzzy-color-surface-muted);
		}

		.fuzzy-course-tree-group summary {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 8px;
			padding: 6px 8px;
			cursor: pointer;
			font-size: 0.76rem;
			font-weight: 800;
			list-style: none;
		}

		.fuzzy-course-tree-group summary::before {
			content: "▸";
			width: 12px;
			color: var(--fuzzy-color-primary);
			font-size: 0.9rem;
		}

		.fuzzy-course-tree-group[open] summary::before {
			content: "▾";
		}

		.fuzzy-course-tree-group summary::-webkit-details-marker {
			display: none;
		}

		.fuzzy-course-tree-group summary small {
			color: var(--fuzzy-color-text-muted);
			font-size: 0.66rem;
		}

		.fuzzy-course-tree-items {
			display: grid;
			gap: 3px;
			padding: 0 5px 5px 16px;
		}

		.fuzzy-course-tree-option {
			display: flex;
			align-items: center;
			gap: 7px;
			border: 0;
			border-radius: 6px;
			padding: 6px 8px;
			background: transparent;
			color: var(--fuzzy-color-text-secondary);
			font: inherit;
			font-size: 0.74rem;
			text-align: left;
			cursor: pointer;
		}

		.fuzzy-course-tree-option input {
			margin: 0;
			accent-color: var(--fuzzy-color-primary);
		}

		.fuzzy-course-tree-option.is-selected {
			background: var(--fuzzy-color-primary-soft);
			color: var(--fuzzy-color-primary-strong);
			font-weight: 800;
		}

		.fuzzy-search-input-wrap {
			display: flex;
			align-items: center;
			gap: 12px;
			border: 2px solid var(--fuzzy-color-primary);
			border-radius: 14px;
			padding: 12px 14px;
			background: var(--fuzzy-color-surface);
		}

		.fuzzy-search-dot {
			width: 14px;
			height: 14px;
			border-radius: 5px;
			background: var(--fuzzy-color-primary);
			flex: 0 0 auto;
		}

		.fuzzy-search-input-wrap input {
			width: 100%;
			min-width: 0;
			border: 0;
			outline: 0;
			background: transparent;
			color: var(--fuzzy-color-text-strong);
			font: inherit;
			font-size: 1rem;
			font-weight: 800;
		}

		.fuzzy-primary-button {
			border: 0;
			border-radius: 12px;
			padding: 12px 22px;
			background: var(--fuzzy-brand-gradient);
			color: var(--fuzzy-color-surface);
			font: inherit;
			font-weight: 800;
			cursor: pointer;
		}

		.fuzzy-search-meta {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 16px;
			margin-top: 12px;
			color: var(--fuzzy-color-text-muted);
			font-size: 0.82rem;
			font-weight: 700;
		}

		.fuzzy-toggle {
			display: inline-flex;
			align-items: center;
			gap: 10px;
			color: var(--fuzzy-color-text-subtle);
		}

		.fuzzy-toggle input {
			display: none;
		}

		.fuzzy-toggle-ui {
			position: relative;
			width: 36px;
			height: 20px;
			border-radius: 999px;
			background: var(--fuzzy-color-border);
		}

		.fuzzy-toggle-ui::after {
			content: "";
			position: absolute;
			top: 3px;
			left: 3px;
			width: 14px;
			height: 14px;
			border-radius: 50%;
			background: var(--fuzzy-color-surface);
		}

		.fuzzy-search-layout {
			display: grid;
			grid-template-columns: minmax(0, 1.9fr) minmax(260px, 0.95fr);
			gap: 18px;
		}

		.fuzzy-result-list {
			display: grid;
			gap: 12px;
		}

		.fuzzy-result-row {
			display: grid;
			grid-template-columns: 48px minmax(0, 170px) minmax(0, 1fr) minmax(150px, 180px);
			gap: 14px;
			align-items: center;
			border: 0;
			border-radius: 12px;
			padding: 14px;
			background: var(--fuzzy-color-surface);
			box-shadow: inset 0 0 0 1px var(--fuzzy-color-border-soft);
			color: inherit;
			text-align: left;
			cursor: pointer;
		}

		.fuzzy-result-row.is-selected {
			box-shadow: inset 0 0 0 2px var(--fuzzy-color-primary);
			background: var(--fuzzy-color-page);
		}

		.fuzzy-result-kind {
			display: inline-grid;
			place-items: center;
			border-radius: 8px;
			padding: 8px 0;
			background: var(--fuzzy-color-danger);
			color: var(--fuzzy-color-surface);
			font-size: 0.68rem;
			font-weight: 900;
		}

		.fuzzy-result-kind.is-ppt {
			background: var(--fuzzy-brand-orange);
		}

		.fuzzy-result-kind.is-doc {
			background: var(--fuzzy-brand-blue);
		}

		.fuzzy-result-title,
		.fuzzy-result-sub,
		.fuzzy-result-snippet,
		.fuzzy-result-side p,
		.fuzzy-note-grid dt,
		.fuzzy-note-grid dd {
			margin: 0;
		}

		.fuzzy-result-main {
			min-width: 0;
		}

		.fuzzy-result-title {
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			font-size: 0.95rem;
			font-weight: 900;
		}

		.fuzzy-result-sub {
			margin-top: 4px;
			color: var(--fuzzy-color-text-subtle);
			font-size: 0.74rem;
			font-weight: 700;
		}

		.fuzzy-result-snippet {
			min-width: 0;
			overflow: hidden;
			display: -webkit-box;
			-webkit-box-orient: vertical;
			-webkit-line-clamp: 2;
			text-overflow: ellipsis;
			color: var(--fuzzy-color-text-secondary);
			font-size: 0.84rem;
			line-height: 1.7;
		}

		.fuzzy-result-side {
			display: grid;
			gap: 8px;
			justify-items: end;
			color: var(--fuzzy-color-primary);
			font-size: 0.78rem;
			font-weight: 900;
		}

		.fuzzy-result-match-count {
			margin: 0;
			color: var(--fuzzy-color-text-secondary);
			font-size: 0.7rem;
			line-height: 1.45;
			text-align: right;
		}

		.fuzzy-result-side span {
			border-radius: 10px;
			padding: 8px 12px;
			background: var(--fuzzy-color-surface-muted);
		}

		.fuzzy-result-detail {
			border: 0;
			padding: 8px 12px;
			border-radius: 10px;
			background: var(--fuzzy-color-surface-muted);
			color: var(--fuzzy-color-primary);
			font: inherit;
			font-size: 0.78rem;
			font-weight: 900;
			cursor: pointer;
		}

		.fuzzy-search-note {
			background:
				linear-gradient(145deg, var(--fuzzy-color-primary-overlay), transparent 48%),
				var(--fuzzy-color-surface);
		}

		.fuzzy-search-note h2,
		.fuzzy-empty h2,
		.fuzzy-placeholder h2 {
			margin: 0 0 10px;
			font-size: 1.18rem;
			font-weight: 900;
		}

		.fuzzy-note-copy {
			color: var(--fuzzy-color-text-secondary);
			font-size: 0.9rem;
			line-height: 1.8;
		}

		.fuzzy-note-grid {
			display: grid;
			gap: 10px;
			margin: 18px 0 0;
		}

		.fuzzy-note-grid div {
			display: grid;
			grid-template-columns: 54px 1fr;
			gap: 10px;
		}

		.fuzzy-note-grid dt {
			color: var(--fuzzy-color-text-subtle);
			font-size: 0.76rem;
			font-weight: 800;
		}

		.fuzzy-note-grid dd {
			font-size: 0.86rem;
			font-weight: 800;
		}

		.fuzzy-metric-grid {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 14px;
		}

		.fuzzy-metric-card {
			padding: 16px;
			border-radius: 14px;
			background: var(--fuzzy-color-surface);
			box-shadow: var(--fuzzy-shadow-card);
		}

		.fuzzy-metric-card.is-warn {
			background: linear-gradient(90deg, var(--fuzzy-color-warning-soft), var(--fuzzy-color-surface) 56%);
			box-shadow:
				inset 4px 0 0 var(--fuzzy-color-warning-border),
				var(--fuzzy-shadow-card);
		}

		.fuzzy-metric-card.is-soft {
			background: var(--fuzzy-color-surface);
		}

		.fuzzy-metric-card.is-warn .fuzzy-metric-label,
		.fuzzy-metric-card.is-warn .fuzzy-metric-value {
			color: var(--fuzzy-color-warning);
		}

		.fuzzy-metric-label {
			margin: 0;
			color: var(--fuzzy-color-text-muted);
			font-size: 0.8rem;
			font-weight: 800;
		}

		.fuzzy-metric-value {
			margin: 10px 0 0;
			font-size: 2rem;
			font-weight: 900;
			line-height: 1;
		}

		.fuzzy-dashboard-actions {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 14px;
			padding: 14px;
			border-radius: 14px;
			background: var(--fuzzy-color-surface);
			box-shadow: var(--fuzzy-shadow-card);
		}

		.fuzzy-dashboard-cache-note {
			margin: 0;
			color: var(--fuzzy-color-text-muted);
			font-size: 0.8rem;
			font-weight: 800;
			line-height: 1.6;
			text-align: right;
		}

		.fuzzy-dashboard-deadline-link {
			margin-left: auto;
			border: 1px solid var(--fuzzy-color-border);
			border-radius: 10px;
			padding: 9px 12px;
			background: var(--fuzzy-color-surface);
			color: var(--fuzzy-color-primary-strong);
			font: inherit;
			font-size: var(--fuzzy-font-size-small);
			font-weight: 800;
			cursor: pointer;
		}

		.fuzzy-dashboard-course-list {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 14px;
		}

		.fuzzy-dashboard-course-groups {
			display: grid;
			gap: 14px;
		}

		.fuzzy-dashboard-course-group {
			border-radius: 14px;
			background: var(--fuzzy-color-surface-muted);
			box-shadow: var(--fuzzy-shadow-card);
		}

		.fuzzy-dashboard-course-group > summary {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			padding: 14px 16px;
			cursor: pointer;
			font-size: 0.92rem;
			font-weight: 900;
			list-style: none;
		}

		.fuzzy-dashboard-course-group > summary::-webkit-details-marker {
			display: none;
		}

		.fuzzy-dashboard-group-count {
			border-radius: 999px;
			padding: 5px 9px;
			background: var(--fuzzy-color-surface);
			color: var(--fuzzy-color-text-muted);
			font-size: 0.72rem;
		}

		.fuzzy-dashboard-course-group .fuzzy-dashboard-course-list {
			padding: 0 14px 14px;
		}

		.fuzzy-review-material-groups {
			display: grid;
			gap: 12px;
		}

		.fuzzy-review-material-group {
			border-radius: 14px;
			background: var(--fuzzy-color-surface-muted);
			box-shadow: var(--fuzzy-shadow-card);
		}

		.fuzzy-review-material-group > summary {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			padding: 14px 16px;
			cursor: pointer;
			list-style: none;
		}

		.fuzzy-review-material-group > summary::-webkit-details-marker {
			display: none;
		}

		.fuzzy-review-material-group > summary::before {
			content: "▸";
			color: var(--fuzzy-color-primary);
		}

		.fuzzy-review-material-group[open] > summary::before {
			content: "▾";
		}

		.fuzzy-review-material-list {
			display: grid;
			gap: 12px;
			padding: 0 14px 14px;
		}

		.fuzzy-dashboard-course {
			display: grid;
			gap: 16px;
			padding: 16px;
			border-radius: 14px;
			background: var(--fuzzy-color-surface);
			box-shadow: var(--fuzzy-shadow-card);
		}

		.fuzzy-dashboard-course.is-warn {
			box-shadow:
				inset 4px 0 0 var(--fuzzy-color-warning-border),
				var(--fuzzy-shadow-card);
		}

		.fuzzy-dashboard-course-head {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 12px;
		}

		.fuzzy-dashboard-course-head h2 {
			margin: 0;
			font-size: 1.05rem;
			font-weight: 900;
		}

		.fuzzy-dashboard-file-count {
			flex: 0 0 auto;
			border-radius: 999px;
			padding: 6px 10px;
			background: var(--fuzzy-color-surface-muted);
			color: var(--fuzzy-color-text-secondary);
			font-size: 0.74rem;
			font-weight: 900;
		}

		.fuzzy-dashboard-course-details {
			display: grid;
			gap: 10px;
			margin: 0;
		}

		.fuzzy-dashboard-course-details div {
			display: grid;
			grid-template-columns: 74px 1fr;
			gap: 10px;
		}

		.fuzzy-dashboard-course-details dt {
			color: var(--fuzzy-color-text-subtle);
			font-size: 0.76rem;
			font-weight: 800;
		}

		.fuzzy-dashboard-course-details dd {
			margin: 0;
			font-size: 0.86rem;
			font-weight: 800;
		}

		.fuzzy-sync-panel {
			display: grid;
			gap: 14px;
			padding: 16px;
			border-radius: 14px;
			background:
				linear-gradient(145deg, var(--fuzzy-color-primary-overlay), transparent 48%),
				var(--fuzzy-color-surface);
			box-shadow: var(--fuzzy-shadow-card);
		}

		.fuzzy-sync-head {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 14px;
		}

		.fuzzy-sync-head h2,
		.fuzzy-change-row h3,
		.fuzzy-sync-message,
		.fuzzy-sync-meta,
		.fuzzy-change-field,
		.fuzzy-sync-error p {
			margin: 0;
		}

		.fuzzy-sync-head h2 {
			font-size: 1.18rem;
			font-weight: 900;
		}

		.fuzzy-sync-action {
			border: 0;
			border-radius: 999px;
			padding: 8px 12px;
			background: var(--fuzzy-color-surface-muted);
			color: var(--fuzzy-color-text-secondary);
			font: inherit;
			font-size: 0.78rem;
			font-weight: 800;
			cursor: pointer;
			white-space: nowrap;
		}

		.fuzzy-sync-action:disabled {
			cursor: wait;
			opacity: 0.7;
		}

		.fuzzy-sync-summary {
			display: grid;
			gap: 4px;
		}

		.fuzzy-sync-message {
			font-size: 1rem;
			font-weight: 900;
		}

		.fuzzy-sync-meta,
		.fuzzy-change-field {
			color: var(--fuzzy-color-text-muted);
			font-size: 0.8rem;
			font-weight: 800;
		}

		.fuzzy-sync-counts {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 10px;
		}

		.fuzzy-sync-count {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 10px;
			border-radius: 12px;
			padding: 10px 12px;
			background: var(--fuzzy-color-surface-glass);
			box-shadow: inset 0 0 0 1px var(--fuzzy-color-border-soft);
			color: var(--fuzzy-color-text-muted);
			font-size: 0.8rem;
			font-weight: 800;
		}

		.fuzzy-sync-count strong {
			color: var(--fuzzy-color-text-strong);
			font-size: 1.2rem;
			font-weight: 900;
		}

		.fuzzy-change-list {
			display: grid;
			gap: 10px;
		}

		.fuzzy-change-list-label {
			margin: 0;
			color: var(--fuzzy-color-text-muted);
			font-size: 0.8rem;
			font-weight: 800;
		}

		.fuzzy-change-row {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(220px, 0.75fr);
			gap: 14px;
			align-items: center;
			border-radius: 12px;
			padding: 12px;
			background: var(--fuzzy-color-surface);
			box-shadow: inset 0 0 0 1px var(--fuzzy-color-border-soft);
		}

		.fuzzy-change-row h3 {
			font-size: 0.96rem;
			font-weight: 900;
		}

		.fuzzy-change-diff {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
			gap: 8px;
			align-items: center;
		}

		.fuzzy-change-value {
			border-radius: 10px;
			padding: 8px 10px;
			background: var(--fuzzy-color-background);
			font-size: 0.78rem;
			font-weight: 800;
			line-height: 1.5;
		}

		.fuzzy-change-value.is-new {
			background: var(--fuzzy-color-success-soft);
			color: var(--fuzzy-color-success-strong);
		}

		.fuzzy-change-arrow {
			color: var(--fuzzy-color-primary);
			font-weight: 900;
		}

		.fuzzy-sync-error {
			display: grid;
			gap: 6px;
			border-radius: 12px;
			padding: 12px;
			background: var(--fuzzy-color-danger-soft);
			color: var(--fuzzy-color-danger);
			font-size: 0.86rem;
			font-weight: 800;
			line-height: 1.7;
		}

		.fuzzy-deadline-toolbar {
			padding: 14px;
			border-radius: 14px;
			background: var(--fuzzy-color-surface);
			box-shadow: var(--fuzzy-shadow-card);
		}

		.fuzzy-filter-row {
			display: flex;
			flex-wrap: wrap;
			gap: 10px;
			margin-bottom: 10px;
		}

		.fuzzy-filter-chip {
			border: 0;
			border-radius: 999px;
			padding: 8px 14px;
			background: var(--fuzzy-color-surface-muted);
			color: var(--fuzzy-color-text-secondary);
			font: inherit;
			font-size: 0.8rem;
			font-weight: 800;
			cursor: pointer;
		}

		.fuzzy-filter-chip.is-active {
			background: var(--fuzzy-color-primary);
			color: var(--fuzzy-color-surface);
		}

		.fuzzy-toolbar-copy {
			margin: 0;
			color: var(--fuzzy-color-text-muted);
			font-size: 0.84rem;
			line-height: 1.7;
		}

		.fuzzy-deadline-list {
			display: grid;
			gap: 14px;
		}

		.fuzzy-deadline-card {
			padding: 16px;
			border-radius: 14px;
			background: var(--fuzzy-color-surface);
			box-shadow: var(--fuzzy-shadow-card);
		}

		.fuzzy-deadline-card.is-review {
			background: var(--fuzzy-color-warning-soft);
		}

		.fuzzy-deadline-card.is-overdue {
			box-shadow:
				inset 4px 0 0 var(--fuzzy-brand-orange),
				var(--fuzzy-shadow-card);
		}

		.fuzzy-deadline-card.is-submitted {
			opacity: 0.72;
		}

		.fuzzy-deadline-head {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 14px;
		}

		.fuzzy-course-name {
			margin: 0 0 4px;
			color: var(--fuzzy-color-text-subtle);
			font-size: 0.76rem;
			font-weight: 800;
		}

		.fuzzy-deadline-head h2 {
			margin: 0;
			font-size: 1.06rem;
			font-weight: 900;
		}

		.fuzzy-deadline-badges {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			justify-content: flex-end;
		}

		.fuzzy-badge {
			border-radius: 999px;
			padding: 6px 10px;
			background: var(--fuzzy-color-surface-muted);
			font-size: 0.74rem;
			font-weight: 800;
		}

		.fuzzy-badge.is-review {
			background: var(--fuzzy-color-warning-soft);
			color: var(--fuzzy-color-warning);
		}

		.fuzzy-badge.is-overdue {
			background: var(--fuzzy-color-danger-soft);
			color: var(--fuzzy-color-danger);
		}

		.fuzzy-badge.is-submitted {
			background: var(--fuzzy-color-success-soft);
			color: var(--fuzzy-color-success-strong);
		}

		.fuzzy-badge.is-open {
			background: var(--fuzzy-color-info-soft);
			color: var(--fuzzy-color-info);
		}

		.fuzzy-badge.is-available {
			background: var(--fuzzy-color-success-soft);
			color: var(--fuzzy-color-success-strong);
		}

		.fuzzy-deadline-body {
			display: grid;
			gap: 6px;
			margin-top: 12px;
		}

		.fuzzy-deadline-label {
			margin: 0;
			color: var(--fuzzy-color-text-subtle);
			font-size: 0.76rem;
			font-weight: 800;
		}

		.fuzzy-deadline-value {
			margin: 0;
			font-size: 0.95rem;
			font-weight: 900;
		}

		.fuzzy-deadline-source {
			margin: 0;
			color: var(--fuzzy-color-text-subtle);
			font-size: 0.82rem;
			line-height: 1.7;
		}

		.fuzzy-checkline {
			display: inline-flex;
			align-items: center;
			gap: 10px;
			margin-top: 14px;
			font-size: 0.84rem;
			font-weight: 800;
		}

		.fuzzy-deadline-actions {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
		}

		.fuzzy-secondary-link {
			margin-top: 14px;
			color: var(--fuzzy-color-primary-strong);
			font-size: 0.84rem;
			font-weight: 800;
			text-decoration: underline;
			text-underline-offset: 3px;
		}

		.fuzzy-secondary-link:is(button) {
			border: 0;
			padding: 0;
			background: transparent;
			font: inherit;
			cursor: pointer;
		}

		.fuzzy-placeholder {
			color: var(--fuzzy-color-text-secondary);
			font-size: 0.95rem;
			line-height: 1.8;
		}

		.fuzzy-placeholder p {
			margin: 0;
		}

		.fuzzy-loading,
		.fuzzy-error {
			margin: 0;
			font-weight: 800;
		}

		.fuzzy-error {
			color: var(--fuzzy-color-danger);
		}

		.fuzzy-error-panel {
			padding: 16px;
			border-radius: 14px;
			background: var(--fuzzy-color-danger-soft);
			color: var(--fuzzy-color-danger);
			box-shadow: var(--fuzzy-shadow-card);
			font-size: 0.9rem;
			font-weight: 800;
			line-height: 1.7;
		}

		.fuzzy-error-panel-head {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 12px;
		}

		.fuzzy-error-panel-head p {
			margin: 0;
		}

		.fuzzy-error-close {
			border: 0;
			border-radius: 999px;
			padding: 6px 12px;
			background: var(--fuzzy-color-danger-soft);
			color: var(--fuzzy-color-danger);
			font: inherit;
			font-size: 0.78rem;
			font-weight: 800;
			cursor: pointer;
			flex: 0 0 auto;
		}

		.fuzzy-nav-button:focus,
		.fuzzy-side-link:focus,
		.fuzzy-close-button:focus,
		.fuzzy-primary-button:focus,
		.fuzzy-sync-action:focus,
		.fuzzy-error-close:focus,
		.fuzzy-result-row:focus,
		.fuzzy-filter-chip:focus,
		.fuzzy-checkline input:focus,
		.fuzzy-search-input-wrap:focus-within {
			outline: 3px solid var(--fuzzy-focus-ring);
			outline-offset: 2px;
		}

		.fuzzy-side-link:focus {
			outline-color: var(--fuzzy-focus-ring-inverse);
		}

		@media (max-width: 1080px) {
			#${SHELL_PAGE_ID} {
				grid-template-columns: 92px minmax(0, 1fr);
			}

			.fuzzy-sidebar {
				grid-template-rows: auto 1fr;
				gap: 18px;
				padding: 14px 10px;
			}

			.fuzzy-side-nav {
				gap: 10px;
			}

			.fuzzy-side-link {
				display: grid;
				justify-items: center;
				gap: 6px;
				border-radius: 12px;
				padding: 10px 6px;
				font-size: 0.68rem;
				line-height: 1.25;
				text-align: center;
			}
			.fuzzy-side-label {
				flex: none;
			}
			.fuzzy-brand {
				justify-content: center;
			}

			.fuzzy-brand span:last-child {
				display: none;
			}

			.fuzzy-side-dot {
				width: 10px;
				height: 10px;
			}

			.fuzzy-content {
				min-height: 0;
				padding: 18px 18px 24px;
			}

			.fuzzy-search-layout {
				grid-template-columns: 1fr;
			}

			.fuzzy-metric-grid {
				grid-template-columns: 1fr;
			}

			.fuzzy-dashboard-course-list,
			.fuzzy-sync-counts,
			.fuzzy-change-row {
				grid-template-columns: 1fr;
			}
		}

		@media (max-width: 760px) {
			.fuzzy-content {
				padding: 14px;
			}

			.fuzzy-screen-header h1 {
				font-size: 1.5rem;
			}

			.fuzzy-search-form {
				grid-template-columns: 1fr;
			}

			.fuzzy-search-scope {
				grid-template-columns: 1fr;
			}

			.fuzzy-result-row {
				grid-template-columns: 1fr;
			}

			.fuzzy-result-side {
				justify-items: start;
			}

			.fuzzy-deadline-head {
				flex-direction: column;
			}

			.fuzzy-deadline-badges {
				justify-content: flex-start;
			}

			.fuzzy-dashboard-actions {
				align-items: flex-start;
				flex-direction: column;
			}

			.fuzzy-dashboard-cache-note {
				text-align: left;
			}

			.fuzzy-dashboard-deadline-link {
				margin-left: 0;
			}
		}
	`;

	document.head.append(style);
}
