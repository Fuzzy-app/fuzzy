const RULES_STYLE_ID = "fuzzy-rules-screen-style";

export function ensureRulesScreenStyle(): void {
	if (document.getElementById(RULES_STYLE_ID)) return;

	const style = document.createElement("style");
	style.id = RULES_STYLE_ID;
	style.textContent = `
		.fuzzy-rules-screen {
			padding-bottom: 24px;
		}

		.fuzzy-rule-settings-panel {
			display: grid;
			gap: 16px;
		}

		.fuzzy-rules-tabs {
			display: flex;
			flex-wrap: wrap;
			gap: 10px;
			padding: 10px;
			border-radius: 14px;
			background: var(--fuzzy-color-surface);
			box-shadow: var(--fuzzy-shadow-card);
		}

		.fuzzy-rules-tab {
			border: 0;
			border-radius: 10px;
			padding: 9px 14px;
			background: var(--fuzzy-color-surface-muted);
			color: var(--fuzzy-color-text-secondary);
			font: inherit;
			font-size: var(--fuzzy-font-size-small);
			font-weight: 800;
		}

		.fuzzy-rules-tab.is-active {
			background: var(--fuzzy-color-primary);
			color: var(--fuzzy-color-surface);
		}

		.fuzzy-rules-tab:disabled {
			cursor: not-allowed;
			opacity: 0.72;
		}

		.fuzzy-rules-overview {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 14px;
		}

		.fuzzy-rules-summary-card {
			display: grid;
			gap: 8px;
			padding: 16px;
			border-radius: 14px;
			background: var(--fuzzy-color-surface);
			box-shadow: var(--fuzzy-shadow-card);
		}

		.fuzzy-rules-summary-card.is-accent {
			background: var(--fuzzy-color-primary-soft);
		}

		.fuzzy-rules-summary-card.is-future {
			background: var(--fuzzy-color-warning-soft);
		}

		.fuzzy-rules-summary-label,
		.fuzzy-rules-summary-value,
		.fuzzy-rules-summary-copy {
			margin: 0;
		}

		.fuzzy-rules-summary-label {
			color: var(--fuzzy-color-text-secondary);
			font-size: var(--fuzzy-font-size-caption);
			font-weight: 800;
			line-height: 1.5;
		}

		.fuzzy-rules-summary-value {
			font-size: 1.1rem;
			font-weight: 900;
			line-height: 1.45;
			word-break: break-word;
		}

		.fuzzy-rules-summary-copy {
			color: var(--fuzzy-color-text-muted);
			font-size: var(--fuzzy-font-size-small);
			font-weight: 700;
			line-height: var(--fuzzy-line-height-body);
		}

		.fuzzy-rules-panel {
			display: grid;
			gap: 16px;
			padding: 18px;
			border-radius: 14px;
			background: var(--fuzzy-color-surface);
			box-shadow: var(--fuzzy-shadow-card);
		}

		.fuzzy-rules-panel-head {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 18px;
		}

		.fuzzy-rules-panel-head h2,
		.fuzzy-rules-panel-head p,
		.fuzzy-rules-override-head h3,
		.fuzzy-rules-override-head p,
		.fuzzy-rules-preview p,
		.fuzzy-rules-message p,
		.fuzzy-rules-empty p {
			margin: 0;
		}

		.fuzzy-rules-panel-head h2 {
			font-size: 1.18rem;
			font-weight: 900;
		}

		.fuzzy-rules-panel-copy {
			max-width: 720px;
			margin-top: 6px !important;
			color: var(--fuzzy-color-text-muted);
			font-size: var(--fuzzy-font-size-small);
			font-weight: 600;
			line-height: var(--fuzzy-line-height-body);
		}

		.fuzzy-rules-count-badge,
		.fuzzy-rules-kind-badge {
			flex: 0 0 auto;
			border-radius: 999px;
			padding: 7px 11px;
			background: var(--fuzzy-color-surface-muted);
			color: var(--fuzzy-color-text-secondary);
			font-size: var(--fuzzy-font-size-caption);
			font-weight: 900;
		}

		.fuzzy-rules-kind-badge.is-no-section {
			background: #fff0c2;
			color: #8a6410;
		}

		.fuzzy-rules-preset-grid {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 10px;
		}

		.fuzzy-rules-preset {
			display: grid;
			gap: 6px;
			border: 0;
			border-radius: 12px;
			padding: 12px;
			background: var(--fuzzy-color-background);
			color: var(--fuzzy-color-text-secondary);
			font: inherit;
			text-align: left;
			cursor: pointer;
			box-shadow: inset 0 0 0 1px var(--fuzzy-color-border);
		}

		.fuzzy-rules-preset strong {
			color: var(--fuzzy-color-text);
			font-size: var(--fuzzy-font-size-small);
			font-weight: 900;
		}

		.fuzzy-rules-preset code {
			color: var(--fuzzy-color-text-muted);
			font-size: var(--fuzzy-font-size-caption);
			font-weight: 600;
			line-height: 1.55;
			white-space: normal;
			word-break: break-word;
		}

		.fuzzy-rules-preset.is-active {
			background: var(--fuzzy-color-primary-soft);
			box-shadow: inset 0 0 0 2px var(--fuzzy-color-primary);
		}

		.fuzzy-rules-field {
			display: grid;
			gap: 7px;
		}

		.fuzzy-rules-field > span {
			color: var(--fuzzy-color-text-secondary);
			font-size: var(--fuzzy-font-size-small);
			font-weight: 900;
		}

		.fuzzy-rules-input,
		.fuzzy-rules-select,
		.fuzzy-rules-textarea {
			width: 100%;
			min-width: 0;
			border: 1px solid #dfe2f2;
			border-radius: 11px;
			padding: 10px 12px;
			background: var(--fuzzy-color-surface);
			color: var(--fuzzy-color-text);
			font: inherit;
			font-size: var(--fuzzy-font-size-body);
			font-weight: 700;
		}

		.fuzzy-rules-textarea {
			min-height: 78px;
			resize: vertical;
			line-height: 1.6;
		}

		.fuzzy-rules-input:focus,
		.fuzzy-rules-select:focus,
		.fuzzy-rules-textarea:focus,
		.fuzzy-rules-preset:focus,
		.fuzzy-rules-tab:focus,
		.fuzzy-rules-secondary-button:focus,
		.fuzzy-rules-save-button:focus,
		.fuzzy-rules-checkbox input:focus {
			outline: 3px solid var(--fuzzy-focus-ring);
			outline-offset: 2px;
		}

		.fuzzy-rules-help {
			margin: 0;
			color: var(--fuzzy-color-text-subtle);
			font-size: var(--fuzzy-font-size-caption);
			font-weight: 600;
			line-height: 1.65;
		}

		.fuzzy-rules-validation {
			margin: 0;
			color: var(--fuzzy-color-danger);
			font-size: var(--fuzzy-font-size-caption);
			font-weight: 800;
			line-height: 1.55;
		}

		.fuzzy-rules-preview {
			display: grid;
			gap: 6px;
			border-radius: 12px;
			padding: 12px;
			background: var(--fuzzy-color-page);
			box-shadow: inset 0 0 0 1px var(--fuzzy-color-border);
		}

		.fuzzy-rules-preview-label {
			color: var(--fuzzy-color-text-secondary);
			font-size: var(--fuzzy-font-size-caption);
			font-weight: 800;
		}

		.fuzzy-rules-preview-value {
			color: #303653;
			font-size: var(--fuzzy-font-size-small);
			font-weight: 900;
			line-height: 1.6;
			word-break: break-word;
		}

		.fuzzy-rules-action-row {
			display: flex;
			align-items: center;
			justify-content: flex-end;
			gap: 12px;
		}

		.fuzzy-rules-save-button,
		.fuzzy-rules-secondary-button {
			border: 0;
			border-radius: 11px;
			padding: 10px 16px;
			font: inherit;
			font-size: var(--fuzzy-font-size-small);
			font-weight: 900;
			cursor: pointer;
		}

		.fuzzy-rules-save-button {
			background: var(--fuzzy-color-primary);
			color: var(--fuzzy-color-surface);
		}

		.fuzzy-rules-secondary-button {
			background: var(--fuzzy-color-surface-muted);
			color: var(--fuzzy-color-text-secondary);
		}

		.fuzzy-rules-save-button:disabled,
		.fuzzy-rules-secondary-button:disabled {
			cursor: not-allowed;
			opacity: 0.58;
		}

		.fuzzy-rules-message {
			border-radius: 12px;
			padding: 11px 12px;
			background: var(--fuzzy-color-success-soft);
			color: var(--fuzzy-color-success);
			font-size: var(--fuzzy-font-size-small);
			font-weight: 800;
			line-height: 1.6;
		}

		.fuzzy-rules-message.is-error {
			background: var(--fuzzy-color-danger-soft);
			color: var(--fuzzy-color-danger);
		}

		.fuzzy-rules-message.is-mock {
			background: var(--fuzzy-color-primary-soft);
			color: var(--fuzzy-color-primary-strong);
		}

		.fuzzy-rules-add-row {
			display: grid;
			grid-template-columns: minmax(220px, 1fr) auto;
			gap: 12px;
			align-items: end;
			border-radius: 12px;
			padding: 14px;
			background: var(--fuzzy-color-page);
			box-shadow: inset 0 0 0 1px var(--fuzzy-color-border);
		}

		.fuzzy-rules-override-list {
			display: grid;
			gap: 14px;
		}

		.fuzzy-rules-override-card {
			display: grid;
			gap: 14px;
			border-radius: 14px;
			padding: 16px;
			background: var(--fuzzy-color-surface);
			box-shadow: inset 0 0 0 1px #e5e8f5;
		}

		.fuzzy-rules-override-head {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 14px;
		}

		.fuzzy-rules-override-head h3 {
			font-size: 1rem;
			font-weight: 900;
		}

		.fuzzy-rules-override-id {
			margin-top: 4px !important;
			color: var(--fuzzy-color-text-subtle);
			font-size: var(--fuzzy-font-size-caption);
			font-weight: 700;
		}

		.fuzzy-rules-override-grid {
			display: grid;
			grid-template-columns: minmax(180px, 0.72fr) minmax(240px, 1.28fr);
			gap: 12px;
		}

		.fuzzy-rules-override-grid .fuzzy-rules-field:last-child {
			grid-column: 1 / -1;
		}

		.fuzzy-rules-checkbox {
			display: flex;
			align-items: flex-start;
			gap: 10px;
			border-radius: 11px;
			padding: 11px 12px;
			background: var(--fuzzy-color-background);
			color: #303653;
			font-size: var(--fuzzy-font-size-small);
			font-weight: 800;
			line-height: 1.55;
		}

		.fuzzy-rules-checkbox input {
			margin-top: 3px;
			accent-color: var(--fuzzy-color-primary);
		}

		.fuzzy-rules-empty {
			border-radius: 12px;
			padding: 16px;
			background: var(--fuzzy-color-page);
			color: var(--fuzzy-color-text-muted);
			font-size: var(--fuzzy-font-size-small);
			line-height: 1.7;
		}

		@media (max-width: 1080px) {
			.fuzzy-rules-overview,
			.fuzzy-rules-preset-grid,
			.fuzzy-rules-override-grid {
				grid-template-columns: 1fr;
			}

			.fuzzy-rules-override-grid .fuzzy-rules-field:last-child {
				grid-column: auto;
			}
		}

		@media (max-width: 760px) {
			.fuzzy-rules-panel-head,
			.fuzzy-rules-override-head,
			.fuzzy-rules-action-row {
				align-items: stretch;
				flex-direction: column;
			}

			.fuzzy-rules-add-row {
				grid-template-columns: 1fr;
			}

			.fuzzy-rules-save-button,
			.fuzzy-rules-secondary-button {
				width: 100%;
			}
		}
	`;

	document.head.append(style);
}
