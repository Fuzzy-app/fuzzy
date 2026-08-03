<script lang="ts">
	import { tick } from "svelte";
	import {
		RULE_PRESETS,
		RULE_SEGMENT_KINDS,
		RULE_SEGMENT_LABELS,
		createRuleSegment,
		createRuleSegmentsFromTemplate,
		previewRuleSegments,
		type RulePreviewValues,
		type RuleSegment,
		type RuleSegmentKind,
		validateRuleSegments,
	} from "@fuzzy/shared";

	export let segments: RuleSegment[];
	export let previewValues: RulePreviewValues;
	export let disabled = false;
	export let onChange: (segments: RuleSegment[]) => void = () => undefined;
	export let selectedRuleId: string | null = null;
	export let onPresetSelect: (presetId: string) => void = () => undefined;
	export let showPresets = true;

	function labelFor(kind: RuleSegmentKind): string {
		return RULE_SEGMENT_LABELS[kind];
	}

	const segmentControls = new Map<string, HTMLSelectElement>();
	let announcement = "";

	function registerSegmentControl(node: HTMLSelectElement, segmentId: string) {
		segmentControls.set(segmentId, node);
		return {
			destroy() {
				if (segmentControls.get(segmentId) === node) {
					segmentControls.delete(segmentId);
				}
			},
		};
	}

	function update(next: RuleSegment[]): void {
		segments = next;
		onChange(segments);
	}

	function changeKind(index: number, kind: RuleSegmentKind): void {
		update(
			segments.map((segment, segmentIndex) =>
				segmentIndex === index
					? { ...createRuleSegment(kind, index, segment.value), id: segment.id }
					: segment,
			),
		);
	}

	function changeFixedName(index: number, value: string): void {
		update(
			segments.map((segment, segmentIndex) =>
				segmentIndex === index ? { ...segment, value } : segment,
			),
		);
	}

	async function move(index: number, offset: -1 | 1): Promise<void> {
		const target = index + offset;
		if (target < 0 || target >= segments.length) return;
		const next = [...segments];
		[next[index], next[target]] = [next[target], next[index]];
		const moved = next[target];
		update(next);
		announcement = `${labelFor(moved.kind)}を${target + 1}番目へ移動しました。`;
		await tick();
		segmentControls.get(moved.id)?.focus();
	}

	async function remove(index: number): Promise<void> {
		const removed = segments[index];
		const focusTarget = segments[index + 1] ?? segments[index - 1] ?? null;
		update(segments.filter((_, itemIndex) => itemIndex !== index));
		announcement = `${labelFor(removed.kind)}を削除しました。`;
		await tick();
		if (focusTarget) segmentControls.get(focusTarget.id)?.focus();
	}

	$: validationError = validateRuleSegments(segments);
</script>

{#if showPresets}
	<section class="rule-set-card" aria-labelledby="rule-set-heading">
		<div class="rule-set-heading">
			<div>
				<p class="section-label">ルールセット</p>
				<h3 id="rule-set-heading">保存方法に近いルールを選ぶ</h3>
			</div>
		</div>
		<div class="presets" aria-label="ルールセット">
			{#each RULE_PRESETS as preset}
				<button
					class:selected={selectedRuleId === preset.id}
					type="button"
					on:click={() => {
						update(createRuleSegmentsFromTemplate(preset.template));
						onPresetSelect(preset.id);
					}}
					{disabled}
				>
					<strong>{preset.name}</strong>
					<span>{preset.description}</span>
				</button>
			{/each}
		</div>
	</section>
{/if}

<section class="custom-rule-card" aria-labelledby="custom-rule-heading">
	<div>
		<p class="section-label">カスタムルール</p>
		<h3 id="custom-rule-heading">下の項目を自由に変更する</h3>
		<p class="custom-rule-help">
			ルールセットを選んだ後でも、項目の順番や固定フォルダー名を変更できます。
		</p>
	</div>

	<div class="builder" aria-label="カスタムルールのフォルダーの並び">
		{#each segments as segment, index (segment.id)}
			<div class="row">
				<select
					use:registerSegmentControl={segment.id}
					aria-label={`${index + 1}番目のフォルダー`}
					aria-invalid={validationError ? "true" : undefined}
					aria-describedby={validationError
						? "rule-builder-validation"
						: undefined}
					value={segment.kind}
					on:change={(event) =>
						changeKind(index, event.currentTarget.value as RuleSegmentKind)}
					{disabled}
				>
					{#each RULE_SEGMENT_KINDS as kind}
						<option value={kind}>{labelFor(kind)}</option>
					{/each}
				</select>
				{#if segment.kind === "fixed"}
					<input
						aria-label={`${index + 1}番目の固定フォルダー名`}
						aria-invalid={validationError ? "true" : undefined}
						aria-describedby={validationError
							? "rule-builder-validation"
							: undefined}
						placeholder="例: 配布資料"
						value={segment.value ?? ""}
						on:input={(event) =>
							changeFixedName(index, event.currentTarget.value)}
						{disabled}
					/>
				{/if}
				<div class="actions">
					<button
						type="button"
						on:click={() => move(index, -1)}
						disabled={disabled || index === 0}
						aria-label={`${labelFor(segment.kind)}を上へ移動`}>上へ</button
					>
					<button
						type="button"
						on:click={() => move(index, 1)}
						disabled={disabled || index === segments.length - 1}
						aria-label={`${labelFor(segment.kind)}を下へ移動`}>下へ</button
					>
					<button
						class="danger-button"
						type="button"
						on:click={() => remove(index)}
						{disabled}
						aria-label={`${labelFor(segment.kind)}を削除`}>削除</button
					>
				</div>
			</div>
		{/each}
		<button
			class="add"
			type="button"
			on:click={() =>
				update([...segments, createRuleSegment("fixed", segments.length)])}
			{disabled}>フォルダーを追加</button
		>
	</div>

	{#if validationError}
		<p class="validation" id="rule-builder-validation" role="alert">
			{validationError}
		</p>
	{/if}
	<p class="sr-only" aria-live="polite">{announcement}</p>
	<div class="preview">
		<p>実際のフォルダー名での例</p>
		<strong>{previewRuleSegments(segments, previewValues)}</strong>
	</div>
</section>

<style>
	.presets {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 10px;
	}
	.rule-set-card,
	.custom-rule-card {
		padding: 14px;
		border: 1px solid var(--fuzzy-color-border);
		border-radius: 12px;
		background: var(--fuzzy-color-surface-muted);
	}
	.custom-rule-card {
		margin-top: 14px;
	}
	.rule-set-heading {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 10px;
	}
	.rule-set-heading h3,
	.custom-rule-card h3 {
		margin: 0;
		font-size: 0.92rem;
	}
	.custom-rule-help {
		margin: 5px 0 0;
		color: var(--fuzzy-color-text-muted);
		font-size: 0.74rem;
		line-height: 1.6;
	}
	.presets button,
	.row,
	.preview {
		border: 1px solid var(--fuzzy-color-border);
		border-radius: 10px;
		background: var(--fuzzy-color-surface);
	}
	.presets button {
		display: grid;
		gap: 6px;
		padding: 12px;
		color: var(--fuzzy-color-text);
		text-align: left;
	}
	.presets button.selected {
		border-color: var(--fuzzy-color-primary);
		box-shadow: 0 0 0 3px var(--fuzzy-color-primary-overlay);
	}
	.presets span,
	.preview p {
		color: var(--fuzzy-color-text-muted);
		font-size: 0.74rem;
		line-height: 1.6;
	}
	.builder {
		display: grid;
		gap: 10px;
		margin-top: 14px;
	}
	.row {
		display: grid;
		grid-template-columns: minmax(150px, 0.7fr) minmax(180px, 1fr) auto;
		gap: 10px;
		padding: 11px;
	}
	select,
	input,
	button {
		border-radius: 8px;
		padding: 9px 11px;
		font: inherit;
	}
	select,
	input {
		min-width: 0;
		border: 1px solid var(--fuzzy-color-border);
		background: var(--fuzzy-color-surface);
		color: var(--fuzzy-color-text);
	}
	button {
		border: 0;
		cursor: pointer;
		font-weight: 700;
	}
	button:disabled {
		cursor: default;
		opacity: 0.58;
	}
	button:focus-visible,
	select:focus-visible,
	input:focus-visible {
		outline: 3px solid var(--fuzzy-focus-ring);
		outline-offset: 2px;
	}
	.actions {
		display: flex;
		gap: 6px;
	}
	.actions button,
	.add {
		background: var(--fuzzy-color-surface-muted);
		color: var(--fuzzy-color-text-secondary);
	}
	.actions .danger-button {
		background: var(--fuzzy-color-danger-soft);
		color: var(--fuzzy-color-danger);
	}
	.add {
		justify-self: start;
	}
	.validation {
		margin: 10px 0 0;
		color: var(--fuzzy-color-danger);
		font-size: 0.78rem;
		font-weight: 700;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
	.preview {
		margin-top: 12px;
		padding: 12px;
	}
	.preview p {
		margin: 0 0 4px;
	}
	@media (max-width: 800px) {
		.presets,
		.row {
			grid-template-columns: 1fr;
		}
		.actions {
			flex-wrap: wrap;
		}
	}
</style>
