// 保存パネル（./savePanel.ts）のスタイル定義。DOM構築ロジックと分離している。
export const SAVE_PANEL_ID = "fuzzy-save-panel";
export const SAVE_PANEL_STYLE_ID = "fuzzy-save-panel-style";

export const SAVE_PANEL_STYLE = `
		#${SAVE_PANEL_ID} {
			position: fixed;
			top: 0;
			right: 0;
			z-index: 2147483647;
			width: min(300px, calc(100vw - 24px));
			height: 100vh;
			box-sizing: border-box;
			/* 縦スクロールは内側の .fuzzy-panel-scroll が担当する。
			   パネル自身はclipしない（左端の外へ飛び出す開閉ハンドルを隠さないため）。 */
			overflow: visible;
			border-left: 1px solid #e2e6f0;
			border-top: 3px solid #635bff;
			border-radius: 0;
			background: #ffffff;
			box-shadow: -18px 0 36px rgb(22 34 51 / 10%);
			color: #202537;
			font-family: "Yu Gothic UI", Meiryo, system-ui, sans-serif;
		}

		#${SAVE_PANEL_ID}.is-collapsed {
			top: 50%;
			right: 0;
			height: auto;
			width: auto;
			max-height: none;
			overflow: visible;
			border: 0;
			border-radius: 0;
			background: transparent;
			box-shadow: none;
			transform: translateY(-50%);
		}

		#${SAVE_PANEL_ID} * {
			box-sizing: border-box;
		}

		#${SAVE_PANEL_ID} button,
		#${SAVE_PANEL_ID} input {
			font: inherit;
		}

		.fuzzy-panel-scroll {
			height: 100%;
			overflow-y: auto;
			/* スクロールバーを専用ガターに収め、ヘッダーの操作ボタンに重ならないようにする */
			scrollbar-gutter: stable;
		}

		.fuzzy-panel-header,
		.fuzzy-section,
		.fuzzy-actions {
			border-top: 1px solid #eef1f6;
			padding: 9px 12px;
		}

		.fuzzy-panel-header {
			position: sticky;
			top: 0;
			z-index: 3;
			display: flex;
			align-items: center;
			justify-content: space-between;
			border-top: 0;
			background: #ffffff;
			box-shadow: 0 2px 8px rgb(22 34 51 / 6%);
		}

		.fuzzy-panel-tools {
			position: relative;
			z-index: 1;
			display: flex;
			flex: 0 0 auto;
			gap: 5px;
		}

		.fuzzy-panel-header p,
		.fuzzy-panel-header h2,
		.fuzzy-section h3,
		.fuzzy-actions p,
		.fuzzy-note {
			margin: 0;
		}

		.fuzzy-panel-header p {
			display: flex;
			align-items: center;
			gap: 6px;
			color: #202537;
			font-size: 13px;
			font-weight: 800;
		}

		.fuzzy-panel-header small {
			display: block;
			margin-top: 3px;
			color: #8b93a7;
			font-size: 10px;
			font-weight: 700;
			line-height: 1.35;
		}

		.fuzzy-logo {
			display: inline-grid;
			place-items: center;
			width: 22px;
			height: 22px;
			border-radius: 6px;
			background: #635bff;
			color: #ffffff;
			font-size: 13px;
			font-weight: 900;
		}

		.fuzzy-pill {
			border-radius: 999px;
			background: #f0efff;
			padding: 2px 7px;
			color: #635bff;
			font-size: 10px;
			font-weight: 900;
		}

		.fuzzy-panel-handle {
			position: absolute;
			z-index: 4;
			top: 50%;
			left: -22px;
			width: 24px;
			height: 60px;
			border-radius: 8px 0 0 8px !important;
			padding: 0 !important;
			transform: translateY(-50%);
			box-shadow: -6px 0 18px rgb(22 34 51 / 14%);
			font-size: 18px !important;
			line-height: 1;
		}

		.fuzzy-panel-tab {
			writing-mode: vertical-rl;
			min-width: 36px;
			min-height: 84px;
			border-radius: 8px 0 0 8px !important;
			box-shadow: 0 12px 32px rgb(22 34 51 / 22%);
			letter-spacing: 0;
			font-size: 13px !important;
		}

		#${SAVE_PANEL_ID} button {
			border: 0;
			border-radius: 8px;
			background: #5d5ce2;
			padding: 7px 9px;
			color: #ffffff;
			font-weight: 800;
			cursor: pointer;
			line-height: 1.2;
		}

		.fuzzy-panel-tools button {
			display: inline-grid;
			place-items: center;
			width: 30px;
			height: 30px;
			padding: 0 !important;
			border-radius: 9px !important;
			writing-mode: horizontal-tb;
			font-size: 16px;
		}

		#${SAVE_PANEL_ID} button:disabled {
			background: #a9afc7;
			cursor: not-allowed;
		}

		.fuzzy-panel-summary {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 8px;
			padding: 12px;
			background: #ffffff;
		}

		.fuzzy-panel-summary div {
			display: grid;
			gap: 3px;
			min-width: 0;
		}

		.fuzzy-panel-summary span,
		.fuzzy-file-row small,
		.fuzzy-path-option small,
		.fuzzy-input span,
		.fuzzy-empty {
			color: #687083;
			font-size: 11px;
			font-weight: 700;
		}

		.fuzzy-panel-summary strong,
		.fuzzy-file-row strong,
		.fuzzy-path-option strong {
			overflow-wrap: anywhere;
			font-size: 12px;
		}

		.fuzzy-note {
			margin: 0 10px 9px;
			border-radius: 8px;
			background: #edf1ff;
			padding: 7px 8px;
			color: #34398e;
			font-size: 11px;
			font-weight: 800;
			line-height: 1.5;
		}

		.fuzzy-note-result {
			background: #e2f8ef;
			color: #087457;
		}

		.fuzzy-section-heading {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 8px;
			margin-bottom: 7px;
		}

		.fuzzy-section-heading h3 {
			font-size: 11px;
			font-weight: 900;
		}

		.fuzzy-section-heading button {
			background: transparent;
			color: #5d5ce2;
			font-size: 10px;
		}

		.fuzzy-file-list,
		.fuzzy-path-list {
			display: grid;
			gap: 7px;
		}

		.fuzzy-file-row,
		.fuzzy-path-option,
		.fuzzy-path-feature,
		.fuzzy-check,
		.fuzzy-input {
			display: grid;
			gap: 5px;
			border: 1px solid #e2e6f0;
			border-radius: 8px;
			padding: 7px;
		}

		.fuzzy-file-row,
		.fuzzy-path-option,
		.fuzzy-path-feature,
		.fuzzy-check {
			grid-template-columns: auto minmax(0, 1fr);
			align-items: start;
		}

		.fuzzy-file-row:has(input:checked),
		.fuzzy-path-option:has(input:checked),
		.fuzzy-path-feature:has(input:checked) {
			border-color: #746dff;
			background: #f1f0ff;
			box-shadow: inset 0 0 0 1px #746dff;
		}

		.fuzzy-file-row input,
		.fuzzy-path-option input,
		.fuzzy-path-feature input,
		.fuzzy-check input {
			accent-color: #635bff;
		}

		.fuzzy-file-type {
			grid-column: 2;
			width: fit-content;
			border-radius: 4px;
			background: #ef4444;
			padding: 2px 7px;
			color: #ffffff;
			font-size: 10px;
			font-weight: 900;
		}

		.fuzzy-file-type[data-kind="ppt"],
		.fuzzy-file-type[data-kind="pptx"] {
			background: #f59e0b;
		}

		.fuzzy-file-type[data-kind="doc"],
		.fuzzy-file-type[data-kind="docx"] {
			background: #3b82f6;
		}

		.fuzzy-file-type[data-kind="zip"] {
			background: #64748b;
		}

		.fuzzy-file-row input {
			grid-row: 1 / span 3;
		}

		.fuzzy-file-row small {
			grid-column: 2;
		}

		.fuzzy-path-option span {
			display: grid;
			gap: 3px;
			min-width: 0;
		}

		.fuzzy-path-feature {
			grid-template-columns: auto minmax(0, 1fr) auto;
			margin-bottom: 8px;
		}

		.fuzzy-path-feature span {
			display: grid;
			gap: 3px;
			min-width: 0;
		}

		.fuzzy-path-feature em {
			align-self: center;
			border-radius: 999px;
			background: #c9f7dd;
			padding: 4px 8px;
			color: #0f9f6e;
			font-size: 10px;
			font-style: normal;
			font-weight: 900;
		}

		.fuzzy-path-chips {
			display: grid;
			grid-template-columns: 1fr 1fr;
			gap: 8px;
			margin-bottom: 7px;
		}

		.fuzzy-path-chips button {
			overflow: hidden;
			background: #eef1f6 !important;
			color: #657086 !important;
			text-overflow: ellipsis;
			white-space: nowrap;
			font-size: 11px;
		}


		.fuzzy-input input {
			width: 100%;
			min-height: 34px;
			border: 1px solid #dfe4f0;
			border-radius: 8px;
			padding: 0 8px;
			font-size: 12px;
		}

		.fuzzy-actions {
			position: sticky;
			bottom: 0;
			display: grid;
			gap: 7px;
			background: #ffffff;
			box-shadow: 0 -8px 22px rgb(22 34 51 / 8%);
		}

		.fuzzy-actions p {
			border-radius: 8px;
			background: transparent;
			padding: 0;
			color: #657086;
			font-size: 11px;
			font-weight: 800;
			line-height: 1.5;
		}

		.fuzzy-action-meta {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 8px;
			color: #657086;
			font-size: 10px;
			font-weight: 900;
		}

		.fuzzy-action-meta button {
			background: transparent !important;
			padding: 0 !important;
			color: #5d5ce2 !important;
			font-size: 11px;
		}

		.fuzzy-actions > button {
			min-height: 40px;
			box-shadow: 0 8px 18px rgb(93 92 226 / 28%);
		}

		/* 類似ファイル確認（issue51） */
		.fuzzy-similar-list { display: grid; gap: 7px; }
		.fuzzy-similar-row {
			display: grid; gap: 2px;
			border: 1px solid #f3d8ae; border-radius: 8px;
			background: #fff8ec; padding: 7px;
		}
		.fuzzy-similar-row strong { overflow-wrap: anywhere; font-size: 12px; }
		.fuzzy-similar-row small { color: #8a6d3b; font-size: 10px; font-weight: 700; }
		.fuzzy-confirm-buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
		.fuzzy-confirm-buttons button[data-action="cancel-save"] { background: #eef1f6; color: #657086; }
		.fuzzy-note-warning { background: #fff4e0; color: #8a5b00; }
		.fuzzy-pill-mock { background: #ffe9e3; color: #c2410c; }
		.fuzzy-path-chips button:disabled { background: #f5f6f9 !important; color: #b3bac9 !important; box-shadow: none; cursor: not-allowed; }
	`;
