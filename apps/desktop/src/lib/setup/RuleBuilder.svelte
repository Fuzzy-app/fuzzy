<script lang="ts">
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

	function update(next: RuleSegment[]): void {
		segments = next.map((segment, index) => ({
			...segment,
			id: `${segment.kind}-${index}`,
		}));
		onChange(segments);
	}

	function changeKind(index: number, kind: RuleSegmentKind): void {
		update(
			segments.map((segment, segmentIndex) =>
				segmentIndex === index
					? createRuleSegment(kind, index, segment.value)
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

	function move(index: number, offset: -1 | 1): void {
		const target = index + offset;
		if (target < 0 || target >= segments.length) return;
		const next = [...segments];
		[next[index], next[target]] = [next[target], next[index]];
		update(next);
	}

	$: validationError = validateRuleSegments(segments);
</script>

<div class="presets" aria-label="よく使う並び">
	{#each RULE_PRESETS as preset}
		<button
			type="button"
			on:click={() => update(createRuleSegmentsFromTemplate(preset.template))}
			{disabled}
		>
			<strong>{preset.name}</strong>
			<span>{preset.description}</span>
		</button>
	{/each}
</div>

<div class="builder" aria-label="フォルダーの並び">
	{#each segments as segment, index (segment.id)}
		<div class="row">
			<select
				aria-label={`${index + 1}番目のフォルダー`}
				value={segment.kind}
				on:change={(event) =>
					changeKind(index, event.currentTarget.value as RuleSegmentKind)}
				{disabled}
			>
				{#each RULE_SEGMENT_KINDS as kind}
					<option value={kind}>{RULE_SEGMENT_LABELS[kind]}</option>
				{/each}
			</select>
			{#if segment.kind === "fixed"}
				<input
					aria-label={`${index + 1}番目の固定フォルダー名`}
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
					aria-label={`${RULE_SEGMENT_LABELS[segment.kind]}を上へ移動`}
					>上へ</button
				>
				<button
					type="button"
					on:click={() => move(index, 1)}
					disabled={disabled || index === segments.length - 1}
					aria-label={`${RULE_SEGMENT_LABELS[segment.kind]}を下へ移動`}
					>下へ</button
				>
				<button
					type="button"
					on:click={() =>
						update(segments.filter((_, itemIndex) => itemIndex !== index))}
					{disabled}
					aria-label={`${RULE_SEGMENT_LABELS[segment.kind]}を削除`}>削除</button
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
	<p class="validation" role="alert">{validationError}</p>
{/if}
<div class="preview">
	<p>実際のフォルダー名での例</p>
	<strong>{previewRuleSegments(segments, previewValues)}</strong>
</div>

<style>
	.presets {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 10px;
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
	.add {
		justify-self: start;
	}
	.validation {
		margin: 10px 0 0;
		color: var(--fuzzy-color-danger);
		font-size: 0.78rem;
		font-weight: 700;
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
