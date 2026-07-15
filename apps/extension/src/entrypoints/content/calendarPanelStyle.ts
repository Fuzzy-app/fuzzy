const CALENDAR_PANEL_STYLE_ID = "fuzzy-calendar-panel-style";

export function ensureCalendarPanelStyle(): void {
	if (document.getElementById(CALENDAR_PANEL_STYLE_ID)) return;

	const style = document.createElement("style");
	style.id = CALENDAR_PANEL_STYLE_ID;
	style.textContent = `
		.fuzzy-calendar-panel {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			gap: 18px;
			padding: 18px;
			border-radius: 14px;
			background: var(--fuzzy-color-surface);
			box-shadow: var(--fuzzy-shadow-card);
		}

		.fuzzy-calendar-export,
		.fuzzy-notification-settings {
			display: grid;
			align-content: start;
			gap: 12px;
		}

		.fuzzy-calendar-export {
			grid-template-columns: minmax(0, 1fr) auto;
			align-items: start;
			padding-right: 18px;
			border-right: 1px solid var(--fuzzy-color-border);
		}

		.fuzzy-calendar-panel h2 {
			margin: 0 0 6px;
			font-size: 1.04rem;
			font-weight: 900;
		}

		.fuzzy-calendar-copy,
		.fuzzy-calendar-status {
			margin: 0;
			color: var(--fuzzy-color-text-muted);
			font-size: var(--fuzzy-font-size-small);
			font-weight: 600;
			line-height: var(--fuzzy-line-height-body);
		}

		.fuzzy-calendar-status {
			grid-column: 1 / -1;
			margin-top: -6px;
			font-size: var(--fuzzy-font-size-caption);
			font-weight: 700;
		}

		.fuzzy-calendar-status.is-mock {
			border-radius: 10px;
			padding: 9px 10px;
			background: var(--fuzzy-color-primary-soft);
			color: var(--fuzzy-color-primary-strong);
		}

		.fuzzy-notification-rule-list {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 8px;
		}

		.fuzzy-notification-rule {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 10px;
			border: 1px solid var(--fuzzy-color-border);
			border-radius: 12px;
			padding: 10px 12px;
			background: var(--fuzzy-color-page);
			cursor: pointer;
		}

		.fuzzy-notification-rule span {
			display: grid;
			gap: 2px;
		}

		.fuzzy-notification-rule strong {
			font-size: var(--fuzzy-font-size-small);
		}

		.fuzzy-notification-rule small {
			color: var(--fuzzy-color-text-subtle);
			font-size: var(--fuzzy-font-size-caption);
			font-weight: 700;
		}

		.fuzzy-notification-rule input {
			width: 18px;
			height: 18px;
			accent-color: var(--fuzzy-color-primary);
		}

		.fuzzy-calendar-button {
			border: 0;
			border-radius: 10px;
			padding: 9px 13px;
			background: var(--fuzzy-color-primary);
			color: var(--fuzzy-color-surface);
			font: inherit;
			font-size: var(--fuzzy-font-size-small);
			font-weight: 900;
			cursor: pointer;
		}

		.fuzzy-calendar-button.is-secondary {
			background: var(--fuzzy-color-surface-muted);
			color: var(--fuzzy-color-text-secondary);
		}

		.fuzzy-calendar-button:disabled {
			cursor: not-allowed;
			opacity: 0.6;
		}

		.fuzzy-calendar-button:focus,
		.fuzzy-notification-rule input:focus {
			outline: 3px solid var(--fuzzy-focus-ring);
			outline-offset: 2px;
		}

		.fuzzy-calendar-error {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			border-radius: 10px;
			padding: 10px;
			background: var(--fuzzy-color-danger-soft);
			color: var(--fuzzy-color-danger);
		}

		.fuzzy-calendar-error p {
			margin: 0;
			font-size: var(--fuzzy-font-size-caption);
			font-weight: 800;
			line-height: 1.6;
		}

		@media (max-width: 1080px) {
			.fuzzy-calendar-panel {
				grid-template-columns: 1fr;
			}

			.fuzzy-calendar-export {
				padding-right: 0;
				padding-bottom: 18px;
				border-right: 0;
				border-bottom: 1px solid var(--fuzzy-color-border);
			}
		}

		@media (max-width: 760px) {
			.fuzzy-calendar-export,
			.fuzzy-notification-rule-list {
				grid-template-columns: 1fr;
			}
		}
	`;

	document.head.append(style);
}
