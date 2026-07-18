const RULE_INTEGRITY_STYLE_ID = "fuzzy-rule-integrity-panel-style";

export function ensureRuleIntegrityPanelStyle(): void {
	if (document.getElementById(RULE_INTEGRITY_STYLE_ID)) return;

	const style = document.createElement("style");
	style.id = RULE_INTEGRITY_STYLE_ID;
	style.textContent = `
		.fuzzy-integrity-panel {
			display: grid;
			gap: 16px;
		}

		.fuzzy-integrity-header {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 18px;
			padding: 18px;
			border-radius: 14px;
			background: var(--fuzzy-color-surface);
			box-shadow: var(--fuzzy-shadow-card);
		}

		.fuzzy-integrity-header h2,
		.fuzzy-integrity-header p,
		.fuzzy-integrity-section h3,
		.fuzzy-integrity-card h4,
		.fuzzy-integrity-card p,
		.fuzzy-integrity-metric p,
		.fuzzy-integrity-alert p,
		.fuzzy-integrity-member p,
		.fuzzy-integrity-update-status {
			margin: 0;
		}

		.fuzzy-integrity-header h2 {
			font-size: 1.18rem;
			font-weight: 900;
		}

		.fuzzy-integrity-copy {
			max-width: 720px;
			margin-top: 6px !important;
			color: var(--fuzzy-color-text-muted);
			font-size: var(--fuzzy-font-size-small);
			font-weight: 600;
			line-height: var(--fuzzy-line-height-body);
		}

		.fuzzy-integrity-update-status {
			min-height: 1.4em;
			color: var(--fuzzy-color-text-subtle);
			font-size: var(--fuzzy-font-size-caption);
			font-weight: 700;
		}

		.fuzzy-integrity-summary {
			display: grid;
			grid-template-columns: repeat(4, minmax(0, 1fr));
			gap: 12px;
		}

		.fuzzy-integrity-metric {
			display: grid;
			gap: 6px;
			padding: 15px;
			border-radius: 14px;
			background: var(--fuzzy-color-surface);
			box-shadow: var(--fuzzy-shadow-card);
		}

		.fuzzy-integrity-metric-label {
			color: var(--fuzzy-color-text-secondary);
			font-size: var(--fuzzy-font-size-caption);
			font-weight: 800;
		}

		.fuzzy-integrity-metric-value {
			color: var(--fuzzy-color-text);
			font-size: 1.28rem;
			font-weight: 900;
		}

		.fuzzy-integrity-section {
			display: grid;
			gap: 14px;
			padding: 18px;
			border-radius: 14px;
			background: var(--fuzzy-color-surface);
			box-shadow: var(--fuzzy-shadow-card);
		}

		.fuzzy-integrity-section h3 {
			font-size: 1.08rem;
			font-weight: 900;
		}

		.fuzzy-integrity-section-body,
		.fuzzy-integrity-list,
		.fuzzy-integrity-card,
		.fuzzy-integrity-member-list {
			display: grid;
			gap: 12px;
		}

		.fuzzy-integrity-list,
		.fuzzy-integrity-member-list {
			margin: 0;
			padding: 0;
			list-style: none;
		}

		.fuzzy-integrity-card {
			padding: 15px;
			border: 1px solid var(--fuzzy-color-border);
			border-radius: 12px;
			background: var(--fuzzy-color-page);
		}

		.fuzzy-integrity-card-head,
		.fuzzy-integrity-member-head {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 12px;
		}

		.fuzzy-integrity-card h4 {
			font-size: var(--fuzzy-font-size-body);
			font-weight: 900;
			word-break: break-word;
		}

		.fuzzy-integrity-course,
		.fuzzy-integrity-member-head span {
			margin-top: 3px !important;
			color: var(--fuzzy-color-text-muted);
			font-size: var(--fuzzy-font-size-caption);
			font-weight: 700;
		}

		.fuzzy-integrity-badge {
			flex: 0 0 auto;
			border-radius: 999px;
			padding: 5px 9px;
			background: var(--fuzzy-color-info-soft);
			color: var(--fuzzy-color-info);
			font-size: var(--fuzzy-font-size-caption);
			font-weight: 900;
		}

		.fuzzy-integrity-badge.is-warning {
			background: var(--fuzzy-color-warning-soft);
			color: var(--fuzzy-color-warning);
		}

		.fuzzy-integrity-path {
			color: var(--fuzzy-color-text-muted);
			font-size: var(--fuzzy-font-size-small);
			font-weight: 700;
			line-height: 1.6;
			word-break: break-word;
		}

		.fuzzy-integrity-path code {
			color: var(--fuzzy-color-text-secondary);
			font: inherit;
			font-weight: 900;
		}

		.fuzzy-integrity-reason {
			color: var(--fuzzy-color-text-secondary);
			font-size: var(--fuzzy-font-size-small);
			font-weight: 700;
			line-height: var(--fuzzy-line-height-body);
		}

		.fuzzy-integrity-member {
			display: grid;
			gap: 6px;
			padding: 12px;
			border-radius: 10px;
			background: var(--fuzzy-color-surface);
		}

		.fuzzy-integrity-member strong {
			font-size: var(--fuzzy-font-size-small);
			word-break: break-word;
		}

		.fuzzy-integrity-alert,
		.fuzzy-integrity-empty,
		.fuzzy-integrity-resource-status {
			border-radius: 10px;
			padding: 12px;
			font-size: var(--fuzzy-font-size-small);
			font-weight: 700;
			line-height: var(--fuzzy-line-height-body);
		}

		.fuzzy-integrity-alert {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			background: var(--fuzzy-color-danger-soft);
			color: var(--fuzzy-color-danger);
		}

		.fuzzy-integrity-empty,
		.fuzzy-integrity-resource-status {
			margin: 0;
			background: var(--fuzzy-color-surface-muted);
			color: var(--fuzzy-color-text-muted);
		}

		.fuzzy-integrity-button {
			flex: 0 0 auto;
			border: 0;
			border-radius: 10px;
			padding: 9px 13px;
			background: var(--fuzzy-color-surface);
			color: var(--fuzzy-color-danger);
			font: inherit;
			font-size: var(--fuzzy-font-size-small);
			font-weight: 900;
			cursor: pointer;
		}

		.fuzzy-integrity-button.is-primary {
			background: var(--fuzzy-color-primary);
			color: var(--fuzzy-color-surface);
		}

		.fuzzy-integrity-button:focus {
			outline: 3px solid var(--fuzzy-focus-ring);
			outline-offset: 2px;
		}

		.fuzzy-integrity-button:disabled {
			cursor: not-allowed;
			opacity: 0.58;
		}

		@media (max-width: 960px) {
			.fuzzy-integrity-summary {
				grid-template-columns: repeat(2, minmax(0, 1fr));
			}
		}

		@media (max-width: 760px) {
			.fuzzy-integrity-header,
			.fuzzy-integrity-alert,
			.fuzzy-integrity-card-head,
			.fuzzy-integrity-member-head {
				align-items: stretch;
				flex-direction: column;
			}

			.fuzzy-integrity-summary {
				grid-template-columns: 1fr;
			}

			.fuzzy-integrity-button {
				width: 100%;
			}
		}
	`;

	document.head.append(style);
}
