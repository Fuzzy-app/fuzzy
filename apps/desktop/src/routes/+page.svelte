<script lang="ts">
	import { onMount, tick } from "svelte";
	import fuzzyIconUrl from "../../../extension/public/icon/fuzzy.svg?url";
	import { listen, type UnlistenFn } from "@tauri-apps/api/event";
	import {
		RULE_PRESETS,
		createRulePreviewValues,
		createRuleSegmentsFromTemplate,
		previewRulePattern,
		ruleSegmentsToTemplate,
		type RuleSegment,
		validateRuleSegments,
	} from "@fuzzy/shared";
	import type {
		ExtensionRecoveryStatus,
		LibraryMaintenanceProgress,
	} from "@fuzzy/shared";
	import { getExtensionRecoveryStatusClient } from "$lib/setup/extension-recovery";
	import { isTauriRuntime } from "$lib/setup/extension-install";
	import {
		getSavedSetupConfigurationClient,
		getSetupStatusClient,
		pickBaseFolderClient,
		pickCourseFolderClient,
		saveInitialSetupClient,
		saveSetupChangesClient,
		scanExistingStructureClient,
	} from "$lib/setup/api";
	import {
		createCourseOverrides,
		createSavedCourseOverrides,
	} from "$lib/setup/course-overrides";
	import { inferredCandidateToRuleSegments } from "$lib/setup/inferred-rule";
	import { presentMaintenanceProgress } from "$lib/setup/maintenance-progress";
	import { userFacingOperationError } from "$lib/setup/application-state";
	import {
		configurationToSnapshot,
		createStoredPatternCandidate,
		describeSetupChanges,
		displayBaseFolderName,
		editableRuleSegmentsFromTemplate,
		resolveRuleId,
		type SetupSelectionSnapshot,
	} from "$lib/setup/saved-configuration";
	import ExtensionInstallStep from "$lib/setup/ExtensionInstallStep.svelte";
	import ExtensionRecoveryPanel from "$lib/setup/ExtensionRecoveryPanel.svelte";
	import StartupRecoveryPanel from "$lib/setup/StartupRecoveryPanel.svelte";
	import RuleBuilder from "$lib/setup/RuleBuilder.svelte";
	import type {
		SavedSetupConfiguration,
		SetupDraft,
		SetupStatus,
	} from "$lib/setup/types";
	import {
		getApplicationRecoveryStatusClient,
		type ApplicationRecoveryStatus,
		type LibraryMaintenanceSummary,
	} from "$lib/setup/library-maintenance";

	type SetupFlowMode = "initial" | "reconfigure" | "recovery";
	type RuleSource = "inferred" | "preset" | "custom";

	const rulePreviewExamples = [
		{ course: "情報アーキテクチャ", assignment: "第03回レポート" },
		{ course: "データベース", assignment: "正規化レポート" },
	] as const;
	const englishRulePreviewExamples = [
		{ course: "Information Architecture", assignment: "Assignment 03" },
		{ course: "Database", assignment: "Normalization Report" },
	] as const;
	const basePreviewValues = createRulePreviewValues();
	const englishPreviewValues = {
		...basePreviewValues,
		term: `${basePreviewValues.year} Spring`,
		course: "Database",
		assignment: "Assignment",
	};
	let draft: SetupDraft = {
		baseFolderPath: null,
		selectedCandidateId: null,
		selectedRuleId: "year-course-assignment",
		candidates: [],
		courseOverrides: [],
		lastScannedAt: null,
	};

	let setupStatus: SetupStatus = { done: false };
	let currentStepIndex = 0;
	let isPickingFolder = false;
	let isScanning = false;
	let isSaving = false;
	let scanSummary = { scannedFileCount: 0, warningCount: 0 };
	let manualCourseName = "";
	let maintenanceProgress: LibraryMaintenanceProgress | null = null;
	let errorMessage: string | null = null;
	let successMessage: string | null = null;
	let extensionRecoveryStatus: ExtensionRecoveryStatus | null = null;
	let extensionRecoveryLoadError: string | null = null;
	let isLoadingExtensionRecovery = false;
	let flowMode: SetupFlowMode = "initial";
	let savedConfiguration: SavedSetupConfiguration | null = null;
	let savedConfigurationSnapshot: SetupSelectionSnapshot | null = null;
	let isLoadingSavedConfiguration = false;
	let savedRuleRequiresReplacement = false;
	let ruleSegments: RuleSegment[] = createRuleSegmentsFromTemplate(
		RULE_PRESETS[0]?.template ?? "{course}",
	);
	let ruleSource: RuleSource = "preset";
	let manualRuleMode = false;
	let folderNameLanguage: "ja" | "en" = "ja";
	let applicationRecoveryStatus: ApplicationRecoveryStatus | null = null;
	let applicationRecoveryLoadError: string | null = null;
	let isCheckingApplicationRecovery = true;
	let setupPanelHeading: HTMLHeadingElement | null = null;
	let reconfigureHeading: HTMLHeadingElement | null = null;
	let reconfigureButton: HTMLButtonElement | null = null;
	let maintenanceProgressCard: HTMLElement | null = null;
	const minimumScanLoadingMs = 450;
	const extensionVerificationStartedAt = new Date().toISOString();

	onMount(() => {
		void checkApplicationRecoveryStatus();
	});

	$: if (currentStepIndex === 3) {
		void focusExtensionInstallScreen();
	}

	async function focusExtensionInstallScreen(): Promise<void> {
		await tick();
		if (typeof window !== "undefined") {
			window.scrollTo({ top: 0, behavior: "auto" });
		}
		document.getElementById("extension-install-heading")?.focus({
			preventScroll: true,
		});
	}

	async function checkApplicationRecoveryStatus(): Promise<void> {
		isCheckingApplicationRecovery = true;
		applicationRecoveryLoadError = null;
		try {
			applicationRecoveryStatus = await getApplicationRecoveryStatusClient();
			if (!requiresApplicationRecovery(applicationRecoveryStatus)) {
				await loadNormalApplicationState();
			}
		} catch (error) {
			applicationRecoveryStatus = null;
			applicationRecoveryLoadError = userFacingOperationError(
				error,
				"このPCの設定を確認できませんでした。Fuzzyを再起動するか、もう一度確認してください。",
			);
		} finally {
			isCheckingApplicationRecovery = false;
		}
	}

	function requiresApplicationRecovery(
		status: ApplicationRecoveryStatus | null,
	): boolean {
		return (
			status !== null &&
			(status.dataResetRequired === true ||
				status.database.state !== "ready" ||
				status.searchIndex.state !== "ready")
		);
	}

	async function loadNormalApplicationState(): Promise<void> {
		setupStatus = await getSetupStatusClient();
		if (setupStatus.done) {
			currentStepIndex = 3;
			flowMode = "recovery";
			await loadExtensionRecoveryStatus();
		} else {
			currentStepIndex = 0;
			flowMode = "initial";
			extensionRecoveryStatus = null;
		}
	}

	async function handleApplicationRecovered(message: string): Promise<void> {
		errorMessage = null;
		successMessage = message;
		try {
			applicationRecoveryStatus = await getApplicationRecoveryStatusClient();
			if (!requiresApplicationRecovery(applicationRecoveryStatus)) {
				await loadNormalApplicationState();
			}
		} catch (error) {
			errorMessage =
				error instanceof Error
					? error.message
					: "復旧後のローカルデータを確認できませんでした。";
		}
	}

	async function loadExtensionRecoveryStatus(): Promise<void> {
		isLoadingExtensionRecovery = true;
		extensionRecoveryLoadError = null;
		try {
			const status = await getExtensionRecoveryStatusClient();
			extensionRecoveryStatus = status;
		} catch (error) {
			extensionRecoveryStatus = null;
			extensionRecoveryLoadError =
				error instanceof Error
					? error.message
					: "拡張機能の状態を確認できませんでした。";
		} finally {
			isLoadingExtensionRecovery = false;
		}
	}

	function formatScannedAt(value: string | null): string {
		if (!value) {
			return "未実行";
		}

		return new Intl.DateTimeFormat("ja-JP", {
			month: "numeric",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		}).format(new Date(value));
	}

	function waitForMinimumLoadingTime(startedAt: number): Promise<void> {
		const elapsedMs = Date.now() - startedAt;
		const remainingMs = Math.max(0, minimumScanLoadingMs - elapsedMs);

		return new Promise((resolve) => {
			setTimeout(resolve, remainingMs);
		});
	}

	function selectCandidate(candidateId: string): void {
		const candidate =
			draft.candidates.find(({ id }) => id === candidateId) ?? null;
		const inferredSegments = candidate
			? inferredCandidateToRuleSegments(candidate)
			: null;

		draft = {
			...draft,
			selectedCandidateId: candidateId,
			selectedRuleId: "inferred",
			courseOverrides: createCourseOverrides(candidate, draft.courseOverrides),
		};
		manualRuleMode = false;
		ruleSource = "inferred";
		if (inferredSegments) ruleSegments = inferredSegments;
	}

	function updateRuleSegments(segments: RuleSegment[]): void {
		ruleSegments = segments;
		manualRuleMode = true;
		ruleSource = "custom";
		draft = { ...draft, selectedRuleId: "custom" };
		if (validateRuleSegments(segments) === null) {
			savedRuleRequiresReplacement = false;
		}
	}

	function startCustomRule(): void {
		manualRuleMode = true;
		ruleSource = "custom";
		draft = { ...draft, selectedRuleId: "custom" };
	}

	function selectPreset(presetId: string): void {
		const preset = RULE_PRESETS.find(({ id }) => id === presetId);
		if (!preset) return;
		ruleSource = "preset";
		draft = { ...draft, selectedRuleId: preset.id };
	}

	function setCourseOverrideMode(
		overrideId: string,
		mode: "common" | "override" | "unmanaged",
	): void {
		draft = {
			...draft,
			courseOverrides: draft.courseOverrides.map((override) =>
				override.id === overrideId
					? { ...override, mode, enabled: mode === "override" }
					: override,
			),
		};
	}

	function addCourseName(courseName: string): void {
		courseName = courseName.trim();
		if (
			!courseName ||
			draft.courseOverrides.some((item) => item.courseName === courseName)
		) {
			return;
		}
		draft = {
			...draft,
			courseOverrides: [
				...draft.courseOverrides,
				{
					id: `manual-course-${Date.now()}`,
					courseName,
					description: "利用者が追加した授業です。",
					enabled: false,
					mode: "common",
				},
			],
		};
	}

	function addManualCourse(): void {
		addCourseName(manualCourseName);
		manualCourseName = "";
	}

	async function addCourseFromFolder(): Promise<void> {
		try {
			const path = await pickCourseFolderClient();
			if (!path) return;
			const courseName = displayBaseFolderName(path);
			if (courseName === "まだ選択されていません") return;
			addCourseName(courseName);
		} catch (error) {
			errorMessage =
				error instanceof Error
					? error.message
					: "授業フォルダーを選択できませんでした。";
		}
	}

	async function runScan(path: string): Promise<void> {
		if (isScanning || isSaving) return;
		const startedAt = Date.now();

		isScanning = true;
		errorMessage = null;
		successMessage = null;

		try {
			const scanResult = await scanExistingStructureClient(path);
			const candidates = scanResult.candidates;
			scanSummary = {
				scannedFileCount: scanResult.scannedFileCount,
				warningCount: scanResult.warningCount,
			};
			const selectedCandidate =
				candidates.find((candidate) => candidate.recommended) ??
				candidates[0] ??
				null;

			draft = {
				...draft,
				baseFolderPath: path,
				candidates,
				courseOverrides: createCourseOverrides(
					selectedCandidate,
					draft.courseOverrides,
				),
				selectedCandidateId: selectedCandidate?.id ?? null,
				lastScannedAt: new Date().toISOString(),
			};
			const inferredSegments = selectedCandidate
				? inferredCandidateToRuleSegments(selectedCandidate)
				: null;
			manualRuleMode = inferredSegments === null;
			ruleSource = manualRuleMode ? "custom" : "inferred";
			draft = {
				...draft,
				selectedRuleId: manualRuleMode ? "custom" : "inferred",
			};
			if (inferredSegments) {
				ruleSegments = inferredSegments;
			}
			currentStepIndex = 2;
		} catch {
			errorMessage = "フォルダー全体の読み込みに失敗しました。";
		} finally {
			await waitForMinimumLoadingTime(startedAt);
			isScanning = false;
		}
	}

	async function handlePickFolder(): Promise<void> {
		if (isPickingFolder || isScanning || isSaving) return;
		isPickingFolder = true;
		errorMessage = null;
		successMessage = null;

		try {
			const path = await pickBaseFolderClient();

			if (!path) {
				return;
			}

			await runScan(path);
		} catch {
			errorMessage = "フォルダー選択に失敗しました。";
		} finally {
			isPickingFolder = false;
		}
	}

	async function handleRescan(): Promise<void> {
		if (!draft.baseFolderPath) {
			return;
		}

		await runScan(draft.baseFolderPath);
	}

	function terminalProgressFromSummary(
		summary: LibraryMaintenanceSummary,
	): LibraryMaintenanceProgress {
		return {
			phase: "completed",
			state:
				summary.warnings.length > 0 ? "completedWithWarnings" : "completed",
			completedCount: summary.scannedFileCount,
			totalCount: summary.scannedFileCount,
			warningCount: summary.warnings.length,
		};
	}

	function markMaintenanceFailed(): void {
		if (
			maintenanceProgress?.phase === "completed" &&
			maintenanceProgress.state === "failed"
		) {
			return;
		}
		maintenanceProgress = {
			phase: "completed",
			state: "failed",
			completedCount: maintenanceProgress?.completedCount ?? 0,
			totalCount: maintenanceProgress?.totalCount ?? null,
			warningCount: maintenanceProgress?.warningCount ?? 0,
		};
	}

	function applySavedConfiguration(
		configuration: SavedSetupConfiguration,
	): void {
		const storedCandidate = createStoredPatternCandidate(configuration);
		const editableSegments = editableRuleSegmentsFromTemplate(
			configuration.rule.template,
		);
		savedConfiguration = configuration;
		savedConfigurationSnapshot = configurationToSnapshot(configuration);
		savedRuleRequiresReplacement = editableSegments === null;
		ruleSegments = editableSegments ?? [];
		folderNameLanguage = configuration.rule.folderNameLanguage ?? "ja";
		manualRuleMode = false;
		ruleSource = "preset";
		draft = {
			baseFolderPath: configuration.baseFolderPath,
			selectedCandidateId: storedCandidate.id,
			selectedRuleId: configuration.rule.id,
			candidates: [storedCandidate],
			courseOverrides: createSavedCourseOverrides(
				configuration.courseOverrides.map(({ courseName, mode }) => ({
					courseName,
					mode,
				})),
			),
			lastScannedAt: null,
		};
	}

	async function handleSaveInitialSetup(): Promise<void> {
		if (
			isSaving ||
			isScanning ||
			isPickingFolder ||
			!draft.baseFolderPath ||
			!selectedCandidate ||
			!selectedRule ||
			flowMode === "recovery" ||
			(flowMode === "reconfigure" && !savedConfiguration)
		) {
			return;
		}

		const isReconfiguring = flowMode === "reconfigure";
		isSaving = true;
		maintenanceProgress = {
			phase: "scanning",
			state: "running",
			completedCount: 0,
			totalCount: null,
			warningCount: 0,
		};
		errorMessage = null;
		successMessage = null;
		let unlistenProgress: UnlistenFn | null = null;

		try {
			await scrollMaintenanceProgressIntoView();
			if (isTauriRuntime()) {
				unlistenProgress = await listen<LibraryMaintenanceProgress>(
					"library-maintenance-progress",
					({ payload }) => {
						maintenanceProgress = payload;
					},
				);
			}
			if (isReconfiguring && savedConfiguration) {
				const saved = await saveSetupChangesClient({
					expectedRevision: savedConfiguration.revision,
					path: draft.baseFolderPath,
					pattern: selectedCandidate,
					rule: { ...selectedRule, folderNameLanguage },
					courseOverrides: draft.courseOverrides,
				});
				maintenanceProgress = terminalProgressFromSummary(saved.maintenance);
				setupStatus = await getSetupStatusClient();
				savedConfiguration = await getSavedSetupConfigurationClient();
				savedConfigurationSnapshot =
					configurationToSnapshot(savedConfiguration);
				successMessage = saved.rootChanged
					? `変更内容を保存し、${saved.rebasedFileCount.toLocaleString()}件の資料情報を新しい保存先へ引き継ぎました。`
					: "変更内容を保存しました。保存済みの資料ファイルは変更していません。";
				currentStepIndex = 3;
				flowMode = "recovery";
				await loadExtensionRecoveryStatus();
			} else {
				const saved = await saveInitialSetupClient({
					path: draft.baseFolderPath,
					pattern: selectedCandidate,
					rule: { ...selectedRule, folderNameLanguage },
					courseOverrides: draft.courseOverrides,
				});
				maintenanceProgress = terminalProgressFromSummary(saved.maintenance);
				setupStatus = await getSetupStatusClient();
				successMessage = `設定を保存し、既存資料${saved.maintenance.indexedFileCount}件の情報を準備しました。`;
				currentStepIndex = 3;
			}
		} catch (error) {
			markMaintenanceFailed();
			errorMessage =
				error instanceof Error
					? error.message
					: isReconfiguring
						? "変更内容を保存できませんでした。保存済み設定を読み直して再試行してください。"
						: "初期セットアップの保存に失敗しました。";
		} finally {
			unlistenProgress?.();
			isSaving = false;
		}
	}

	async function scrollMaintenanceProgressIntoView(): Promise<void> {
		await tick();
		maintenanceProgressCard?.scrollIntoView({
			behavior: "smooth",
			block: "end",
		});
	}

	async function startReconfiguration(): Promise<void> {
		if (
			isLoadingSavedConfiguration ||
			isSaving ||
			isScanning ||
			isPickingFolder
		) {
			return;
		}
		isLoadingSavedConfiguration = true;
		errorMessage = null;
		successMessage = null;
		maintenanceProgress = null;
		try {
			const configuration = await getSavedSetupConfigurationClient();
			applySavedConfiguration(configuration);
			flowMode = "reconfigure";
			currentStepIndex = 0;
			await tick();
			setupPanelHeading?.focus();
		} catch (error) {
			errorMessage =
				error instanceof Error
					? error.message
					: "保存済みの設定を読み込めませんでした。現在の設定は変更されていません。";
		} finally {
			isLoadingSavedConfiguration = false;
		}
	}

	async function reloadSavedConfiguration(): Promise<void> {
		if (
			!isReconfiguration ||
			isLoadingSavedConfiguration ||
			isSaving ||
			isScanning ||
			isPickingFolder
		) {
			return;
		}
		isLoadingSavedConfiguration = true;
		errorMessage = null;
		successMessage = null;
		maintenanceProgress = null;
		try {
			const configuration = await getSavedSetupConfigurationClient();
			applySavedConfiguration(configuration);
			currentStepIndex = 0;
			successMessage =
				"最新の設定を読み込みました。変更内容をもう一度確認してください。";
			await tick();
			setupPanelHeading?.focus();
		} catch (error) {
			errorMessage =
				error instanceof Error
					? error.message
					: "保存済みの設定を読み込めませんでした。現在の設定は変更されていません。";
		} finally {
			isLoadingSavedConfiguration = false;
		}
	}

	async function cancelReconfiguration(): Promise<void> {
		if (isSaving || isScanning || isPickingFolder) return;
		flowMode = "recovery";
		currentStepIndex = 3;
		savedConfiguration = null;
		savedConfigurationSnapshot = null;
		savedRuleRequiresReplacement = false;
		maintenanceProgress = null;
		errorMessage = null;
		successMessage = null;
		await tick();
		reconfigureButton?.focus();
	}

	async function handleSetupComplete(): Promise<void> {
		if (!isTauriRuntime()) {
			successMessage = "セットアップを完了しました。";
			return;
		}
		try {
			const { getCurrentWindow } = await import("@tauri-apps/api/window");
			await getCurrentWindow().close();
		} catch {
			successMessage =
				"セットアップを完了しました。画面を閉じて利用を開始できます。";
		}
	}

	$: selectedCandidate =
		draft.candidates.find(
			(candidate) => candidate.id === draft.selectedCandidateId,
		) ?? null;
	$: selectedRule =
		validateRuleSegments(ruleSegments) === null
			? {
					id: resolveRuleId(
						ruleSegmentsToTemplate(ruleSegments),
						savedConfiguration,
					),
					name:
						ruleSource === "inferred"
							? "読み込み結果から選んだルール"
							: ruleSource === "preset"
								? "選択した初期ルール"
								: "自分で作成したルール",
					description: "このセットアップで使用する保存先の並びです。",
					template: ruleSegmentsToTemplate(ruleSegments),
					preview: (folderNameLanguage === "en"
						? englishRulePreviewExamples
						: rulePreviewExamples
					).map(({ course, assignment }) =>
						previewRulePattern(ruleSegmentsToTemplate(ruleSegments), {
							...(folderNameLanguage === "en"
								? englishPreviewValues
								: basePreviewValues),
							course,
							assignment,
						}),
					),
				}
			: null;
	$: currentSelectionSnapshot =
		draft.baseFolderPath && selectedCandidate && selectedRule
			? {
					baseFolderPath: draft.baseFolderPath,
					patternId: selectedCandidate.id,
					courseSegmentIndex: selectedCandidate.courseSegmentIndex,
					ruleTemplate: selectedRule.template,
					courseNames: draft.courseOverrides
						.filter(({ enabled }) => enabled)
						.map(({ courseName }) => courseName),
				}
			: null;
	$: setupChanges =
		savedConfigurationSnapshot && currentSelectionSnapshot
			? describeSetupChanges(
					savedConfigurationSnapshot,
					currentSelectionSnapshot,
				)
			: [];
	$: shouldOfferConfigurationReload =
		isReconfiguration && Boolean(errorMessage?.includes("読み直し"));
	$: canSaveSetup = Boolean(
		draft.baseFolderPath &&
		selectedCandidate &&
		selectedRule &&
		(flowMode === "initial"
			? !setupStatus.done
			: flowMode === "reconfigure" &&
				savedConfiguration &&
				setupChanges.length > 0),
	);
	$: applicationNeedsRecovery = requiresApplicationRecovery(
		applicationRecoveryStatus,
	);
	$: maintenancePresentation = presentMaintenanceProgress(maintenanceProgress);
	$: isRecoveryMode = flowMode === "recovery";
	$: isReconfiguration = flowMode === "reconfigure";
	$: isShowingSavedConfiguration =
		isReconfiguration && draft.lastScannedAt === null;
</script>

<svelte:head>
	<meta
		name="description"
		content="Fuzzy の初期セットアップと、セットアップ後の拡張機能復旧確認を行います。"
	/>
</svelte:head>

<main class="window">
	<header class="titlebar">
		<div class="brand">
			<img class="brand-mark" src={fuzzyIconUrl} alt="" aria-hidden="true" />
			<div class="brand-copy">
				<strong>Fuzzy</strong>
				<span>
					{isCheckingApplicationRecovery || applicationRecoveryLoadError
						? "設定と接続の確認"
						: isRecoveryMode
							? "設定と接続の確認"
							: isReconfiguration
								? "再セットアップ"
								: "初期セットアップ"}
				</span>
			</div>
		</div>
	</header>

	{#if isCheckingApplicationRecovery}
		<section class="startup-check-panel" aria-live="polite">
			<div class="startup-spinner" aria-hidden="true"></div>
			<div>
				<p class="eyebrow">このPCのデータを確認中</p>
				<h1>資料の検索・整理情報を確認しています</h1>
				<p>保存済みの資料ファイルは変更しません。</p>
			</div>
		</section>
	{:else if applicationRecoveryLoadError}
		<section class="startup-check-panel startup-error-panel" role="alert">
			<div class="startup-error-icon" aria-hidden="true">!</div>
			<div>
				<p class="eyebrow">確認が必要です</p>
				<h1>現在の利用状態を確認できませんでした</h1>
				<p>{applicationRecoveryLoadError}</p>
				<button
					class="secondary-button"
					type="button"
					on:click={checkApplicationRecoveryStatus}
				>
					もう一度確認
				</button>
			</div>
		</section>
	{:else if applicationRecoveryStatus && applicationNeedsRecovery}
		<StartupRecoveryPanel
			initialStatus={applicationRecoveryStatus}
			onRecovered={handleApplicationRecovered}
		/>
	{:else}
		<section class="workspace">
			<aside class="sidebar">
				<p class="sidebar-label">
					{currentStepIndex === 3
						? "ブラウザ拡張機能の導入を確認します。"
						: isRecoveryMode
							? "現在の状態と、次にできる操作を確認できます。"
							: isReconfiguration
								? "保存先やフォルダーの作り方を変更できます。保存済み資料は移動・削除しません。"
								: "保存先とフォルダーの作り方を設定します。"}
				</p>
				{#if currentStepIndex !== 3 && !isRecoveryMode}
					<p class="sidebar-note">
						選択したフォルダー全体を読み込み、保存方法に合う候補を提案します。
					</p>
				{:else if currentStepIndex === 3}
					<p class="sidebar-note">
						拡張機能をブラウザへ追加した後、この画面で接続を確認します。
					</p>
				{/if}
			</aside>

			<section class="content">
				{#if currentStepIndex === 3 && errorMessage}
					<p class="error-banner" role="alert">{errorMessage}</p>
				{/if}
				{#if currentStepIndex === 3 && successMessage}
					<p class="success-banner" role="status">{successMessage}</p>
				{/if}
				{#if currentStepIndex !== 3}
					<section class="panel">
						<div class="panel-header">
							<div>
								<h1 bind:this={setupPanelHeading} tabindex="-1">
									{isReconfiguration
										? "保存先と整理ルールを確認・変更する"
										: "大学資料の保存先と整理ルールを設定する"}
								</h1>
								<p class="intro">
									{isReconfiguration
										? "資料があるフォルダーを選ぶと、現在の構成を確認できます。変更を保存するまで、設定や資料は変更しません。"
										: "Fuzzyは大学の資料を整理し、課題や締切を見つけやすくするアプリです。大学資料が入っている最上位のフォルダーを1つ選んでください。選択したフォルダー全体を読み込み、保存方法に近い整理ルールを提案します。"}
								</p>
							</div>
						</div>
						<div class="folder-picker">
							<button
								class="primary-button"
								type="button"
								on:click={handlePickFolder}
								disabled={isPickingFolder || isScanning || isSaving}
							>
								{#if isPickingFolder}
									フォルダーを選択中...
								{:else}
									大学資料の保存先フォルダーを選ぶ
								{/if}
							</button>
						</div>

						<div class="folder-card">
							<div>
								<p class="section-label">選択中の保存先</p>
								<strong>{displayBaseFolderName(draft.baseFolderPath)}</strong>
								{#if draft.baseFolderPath}
									<small>選択したフォルダー内だけを確認します。</small>
								{/if}
							</div>
							<div class="folder-meta">
								<span>
									{isShowingSavedConfiguration
										? "今回の確認: まだ実行していません"
										: `最終スキャン: ${formatScannedAt(draft.lastScannedAt)}`}
								</span>
								<button
									class:loading={isScanning}
									class="ghost-button"
									type="button"
									on:click={handleRescan}
									disabled={!draft.baseFolderPath || isScanning || isSaving}
									aria-busy={isScanning}
								>
									<span class="ghost-button-label">
										{#if isScanning}
											<span class="spinner" aria-hidden="true"></span>
										{/if}
										<span>
											{#if isScanning}
												再スキャン中...
											{:else}
												{isShowingSavedConfiguration
													? "フォルダー全体を読み込む"
													: "再スキャン"}
											{/if}
										</span>
									</span>
								</button>
							</div>
						</div>

						{#if isScanning}
							<section class="scan-loading-card" aria-live="polite">
								<div class="scan-loading-flow" aria-hidden="true">
									<span></span>
								</div>
								<strong>フォルダー全体を読み込んでいます</strong>
								<p>選択したフォルダーの中を順番に確認しています。</p>
							</section>
						{/if}

						{#if setupStatus.done}
							<p class="success-banner" role="status">
								現在の保存先と整理ルールは保存済みです。変更を保存するまで、現在の設定を使い続けます。
								{#if setupStatus.savedAt}
									<span>保存日時: {formatScannedAt(setupStatus.savedAt)}</span>
								{/if}
							</p>
						{/if}

						{#if errorMessage}
							<p class="error-banner" role="alert">{errorMessage}</p>
							{#if shouldOfferConfigurationReload}
								<button
									class="ghost-button reload-configuration-button"
									type="button"
									on:click={reloadSavedConfiguration}
									disabled={isLoadingSavedConfiguration}
								>
									{isLoadingSavedConfiguration
										? "最新の設定を読み込み中..."
										: "保存済み設定を読み直す"}
								</button>
							{/if}
						{/if}

						{#if successMessage}
							<p class="success-banner" role="status">{successMessage}</p>
						{/if}

						{#if draft.lastScannedAt}
							<section class="scan-section">
								<div class="scan-heading">
									<div>
										<p class="section-label">
											{isShowingSavedConfiguration
												? "保存済み設定"
												: "保存パターン推定"}
										</p>
										<h2>
											{isShowingSavedConfiguration
												? "現在のフォルダーの見方"
												: "推定結果"}
										</h2>
									</div>
									<span class="scan-count"
										>{scanSummary.scannedFileCount.toLocaleString()}件を読み込み済み</span
									>
								</div>

								{#if isShowingSavedConfiguration}
									<p class="scan-guidance">
										現在表示しているのは保存済みの設定です。保存先にある資料から現在の並びを確認するには、「フォルダー全体を読み込む」を押してください。
									</p>
								{/if}

								{#if draft.candidates.length === 0}
									<div class="empty-state">
										<p>
											フォルダーを読み込むと、保存方法に近い候補が表示されます。
										</p>
									</div>
								{:else}
									<div class="pattern-list">
										{#each draft.candidates as candidate, index}
											<button
												class:selected={candidate.id ===
													draft.selectedCandidateId}
												class="pattern-card"
												type="button"
												on:click={() => selectCandidate(candidate.id)}
												aria-pressed={candidate.id ===
													draft.selectedCandidateId}
											>
												<div class="pattern-main">
													<div class="pattern-title-row">
														<h3>推定結果 {index + 1}: {candidate.name}</h3>
														{#if candidate.recommended}
															<span class="badge">
																{isShowingSavedConfiguration
																	? "現在の設定"
																	: "おすすめ"}
															</span>
														{/if}
														{#if candidate.requiresConfirmation}
															<span class="badge warning">要確認</span>
														{/if}
													</div>
													<p>{candidate.description}</p>
													<p class="pattern-score">
														{candidate.matchScore === null
															? "一致度を算出できません"
															: `一致度 ${candidate.matchScore}%`}
													</p>
												</div>
											</button>
										{/each}
										<button
											class:selected={manualRuleMode}
											class="pattern-card"
											type="button"
											on:click={startCustomRule}
											aria-pressed={manualRuleMode}
										>
											<div class="pattern-main">
												<div class="pattern-title-row">
													<h3>自分でルールを設定する</h3>
												</div>
												<p>
													推定結果を使わず、下のルールセットを土台にして自由に設定します。
												</p>
											</div>
										</button>
									</div>
								{/if}
							</section>

							<section
								class="folder-name-format"
								aria-labelledby="folder-name-format-heading"
							>
								<div>
									<p class="section-label">保存形式</p>
									<h2 id="folder-name-format-heading">
										フォルダー名の表記を選ぶ
									</h2>
								</div>
								<label>
									<span>保存するフォルダー名</span>
									<select bind:value={folderNameLanguage}>
										<option value="ja">日本語名を使う</option>
										<option value="en">英語名を使う</option>
									</select>
								</label>
							</section>

							{#if manualRuleMode}
								<section class="rule-section">
									<div class="scan-heading">
										<div>
											<p class="section-label">カスタムルール</p>
											<h2>フォルダー作成ルールを設定する</h2>
										</div>
									</div>

									{#if savedRuleRequiresReplacement}
										<p class="warning-banner" role="status">
											保存済みのフォルダーの作り方は、この画面で安全に編集できる形式ではありません。科目を含む新しい並びを組み立ててから保存してください。現在の設定は、保存するまで変わりません。
										</p>
									{/if}

									<RuleBuilder
										segments={ruleSegments}
										previewValues={folderNameLanguage === "en"
											? englishPreviewValues
											: basePreviewValues}
										selectedRuleId={draft.selectedRuleId}
										showPresets={true}
										onPresetSelect={selectPreset}
										disabled={isSaving || isScanning}
										onChange={updateRuleSegments}
									/>
								</section>
							{/if}

							<details class="override-section">
								<summary>
									<span>
										<p class="section-label">授業ごとの扱い</p>
										<strong>初期例外を設定する（必要な場合）</strong>
									</span>
									<span class="details-hint">設定する</span>
								</summary>
								<div class="override-explanation">
									<h2>授業ごとの扱いを選ぶ</h2>
									<p class="override-help">
										Fuzzyから提案された授業だけでなく、授業名を入力して追加できます。共通ルールから外すか、Fuzzyの管理対象外にするかを授業ごとに選べます。
									</p>
								</div>
								<div class="override-list">
									{#each draft.courseOverrides as override}
										<div class="override-row">
											<span>
												<strong>{override.courseName}</strong>
												<small>この授業に適用する扱いを選びます。</small>
											</span>
											<select
												value={override.mode}
												on:change={(event) =>
													setCourseOverrideMode(
														override.id,
														event.currentTarget.value as
															"common" | "override" | "unmanaged",
													)}
											>
												<option value="common">共通ルールを使う</option>
												<option value="override">共通ルールから外す</option>
												<option value="unmanaged">Fuzzyで管理しない</option>
											</select>
										</div>
									{/each}
									<div class="manual-course-row">
										<input
											placeholder="授業名を入力"
											bind:value={manualCourseName}
											on:keydown={(event) => {
												if (event.key === "Enter") addManualCourse();
											}}
										/>
										<button
											class="ghost-button"
											type="button"
											on:click={addManualCourse}
											disabled={!manualCourseName.trim()}
										>
											授業を追加
										</button>
										<button
											class="ghost-button"
											type="button"
											on:click={addCourseFromFolder}
											disabled={isSaving || isScanning}
										>
											フォルダーから授業を追加
										</button>
									</div>
								</div>
							</details>

							<section class="selection-summary">
								<div>
									<p class="section-label">保存内容</p>
									<h2>現在の選択内容</h2>
								</div>
								<div class="summary-card">
									<p>
										<strong>保存先:</strong>
										{displayBaseFolderName(draft.baseFolderPath)}
									</p>
									<p>
										<strong>選択したルール:</strong>
										{selectedRule?.name ?? "未選択"}
									</p>
									<p>
										<strong>選択方法:</strong>
										{ruleSource === "inferred"
											? "読み込み結果から選択"
											: ruleSource === "preset"
												? "初期ルールから選択"
												: "自分で作成"}
									</p>
									{#if selectedRule}
										<p><strong>保存例:</strong> {selectedRule.preview[0]}</p>
									{/if}
									<p>
										<strong>個別設定:</strong>
										{draft.courseOverrides.filter(
											({ mode }) => mode !== "common",
										).length}件
									</p>
									{#if isReconfiguration}
										<div class="change-summary" aria-live="polite">
											<strong>今回の変更</strong>
											{#if setupChanges.length > 0}
												<ul>
													{#each setupChanges as change}
														<li>{change}</li>
													{/each}
												</ul>
											{:else}
												<p>保存が必要な変更はありません。</p>
											{/if}
										</div>
									{/if}
								</div>
							</section>

							<div class="action-row">
								{#if isReconfiguration}
									<button
										class="ghost-button"
										type="button"
										on:click={cancelReconfiguration}
										disabled={isSaving || isScanning || isPickingFolder}
									>
										変更せず戻る
									</button>
								{/if}
								<button
									class="primary-button"
									type="button"
									on:click={handleSaveInitialSetup}
									disabled={!canSaveSetup ||
										isSaving ||
										isScanning ||
										isPickingFolder}
									aria-busy={isSaving}
								>
									{#if isSaving}
										保存中...
									{:else}
										{isReconfiguration
											? "変更内容を保存"
											: "この内容で初期設定を保存"}
									{/if}
								</button>
							</div>
						{/if}
					</section>
				{/if}
				{#if currentStepIndex === 3}
					{#if isRecoveryMode}
						<section
							class="reconfigure-card"
							aria-labelledby="reconfigure-heading"
						>
							<div>
								<p class="eyebrow">設定を変更できます</p>
								<h2
									id="reconfigure-heading"
									bind:this={reconfigureHeading}
									tabindex="-1"
								>
									再セットアップ
								</h2>
								<p>
									保存先やフォルダーの作り方を見直せます。変更内容を確認するまで保存しません。
								</p>
							</div>
							<button
								bind:this={reconfigureButton}
								class="reconfigure-button"
								type="button"
								on:click={startReconfiguration}
								disabled={isLoadingSavedConfiguration}
								aria-busy={isLoadingSavedConfiguration}
							>
								{isLoadingSavedConfiguration
									? "設定を読み込み中..."
									: "設定を変更"}
							</button>
						</section>
						{#if extensionRecoveryStatus}
							<ExtensionRecoveryPanel initialStatus={extensionRecoveryStatus} />
						{:else}
							<section class="panel recovery-load-panel">
								<div class="panel-header">
									<div>
										<p class="eyebrow">拡張機能の状態</p>
										<h1>拡張機能の状態を確認</h1>
										<p>
											保存済みの最終応答を読み取り、拡張機能の状態を確認します。
										</p>
									</div>
								</div>
								{#if extensionRecoveryLoadError}
									<p class="error-banner" role="alert">
										{extensionRecoveryLoadError}
									</p>
								{/if}
								<button
									class="primary-button"
									type="button"
									on:click={loadExtensionRecoveryStatus}
									disabled={isLoadingExtensionRecovery}
								>
									{isLoadingExtensionRecovery ? "確認中..." : "再試行"}
								</button>
							</section>
						{/if}
					{:else}
						<ExtensionInstallStep
							verificationStartedAt={extensionVerificationStartedAt}
							onComplete={handleSetupComplete}
						/>
					{/if}
				{/if}
				{#if maintenanceProgress && currentStepIndex !== 3}
					<section
						bind:this={maintenanceProgressCard}
						class="maintenance-progress-card"
						aria-live="polite"
						aria-atomic="true"
					>
						<div class="maintenance-progress-heading">
							<div>
								<p class="section-label">
									{maintenanceProgress.phase === "completed"
										? "処理結果"
										: isReconfiguration
											? "変更内容を保存中"
											: "初期設定を保存中"}
								</p>
								<strong>{maintenancePresentation.title}</strong>
							</div>
							<span>{maintenancePresentation.countLabel}</span>
						</div>
						<div
							class:indeterminate={maintenancePresentation.percent === null &&
								maintenanceProgress.state === "running"}
							class="maintenance-progress-track"
							role="progressbar"
							aria-label="資料情報の準備状況"
							aria-valuemin="0"
							aria-valuemax="100"
							aria-valuenow={maintenancePresentation.percent ?? undefined}
							aria-valuetext={maintenancePresentation.ariaValueText}
						>
							<span style:width={`${maintenancePresentation.percent ?? 30}%`}
							></span>
						</div>
						<p>{maintenancePresentation.availabilityLabel}</p>
					</section>
				{/if}
			</section>
		</section>
	{/if}
</main>

<style>
	:global(body) {
		margin: 0;
		width: 100%;
		height: 100%;
		overflow: hidden;
		font-family: "BIZ UDPGothic", "Yu Gothic UI", "Segoe UI", sans-serif;
		background:
			linear-gradient(
				180deg,
				var(--fuzzy-color-primary) 0 4px,
				transparent 4px
			),
			radial-gradient(
				circle at top,
				var(--fuzzy-color-primary-overlay),
				transparent 26%
			),
			linear-gradient(
				180deg,
				var(--fuzzy-color-surface-muted) 0%,
				var(--fuzzy-color-surface-muted) 100%
			);
		color: var(--fuzzy-color-text-strong);
	}

	.startup-check-panel {
		width: min(100% - 32px, 720px);
		margin: 80px auto;
		padding: 28px;
		display: flex;
		align-items: center;
		gap: 18px;
		box-sizing: border-box;
		border: 1px solid var(--fuzzy-color-border-overlay);
		border-radius: 12px;
		background: var(--fuzzy-color-surface-glass);
		box-shadow: 0 28px 52px var(--fuzzy-color-primary-overlay);
	}

	.startup-check-panel h1 {
		margin: 0 0 8px;
		font-size: 1.2rem;
	}

	.startup-check-panel p {
		margin: 0;
		color: var(--fuzzy-color-text-muted);
		font-size: 0.8rem;
	}

	.startup-error-panel {
		align-items: flex-start;
		border-color: var(--fuzzy-color-danger);
		background: var(--fuzzy-color-danger-soft);
	}

	.startup-error-panel .secondary-button {
		margin-top: 16px;
	}

	.startup-error-icon {
		width: 30px;
		height: 30px;
		display: grid;
		place-items: center;
		flex: 0 0 auto;
		border-radius: 999px;
		background: var(--fuzzy-color-danger);
		color: var(--fuzzy-color-surface);
		font-weight: 800;
	}

	.reconfigure-card {
		width: min(100%, 880px);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 20px;
		box-sizing: border-box;
		margin: 22px auto 0;
		padding: 18px 22px;
		border: 1px solid var(--fuzzy-color-primary-overlay-strong);
		border-radius: 12px;
		background: var(--fuzzy-color-surface-glass);
		box-shadow: var(--fuzzy-shadow-card);
	}

	.reconfigure-card h2 {
		margin: 0 0 5px;
		font-size: 1.05rem;
	}

	.reconfigure-card p {
		margin: 0;
	}

	.reconfigure-card .eyebrow {
		width: fit-content;
		margin-bottom: 7px;
		padding: 4px 9px;
		border-radius: 999px;
		background: var(--fuzzy-color-primary-overlay);
		color: var(--fuzzy-color-primary);
		font-size: 0.7rem;
		font-weight: 700;
	}

	.reconfigure-card h2 + p {
		color: var(--fuzzy-color-text-muted);
		font-size: 0.78rem;
		line-height: 1.6;
	}

	.reconfigure-button {
		flex: 0 0 auto;
		padding: 10px 14px;
		border: 1px solid var(--fuzzy-color-primary-overlay-strong);
		border-radius: 8px;
		background: var(--fuzzy-color-primary-soft);
		color: var(--fuzzy-color-primary-strong);
		font: inherit;
		font-size: 0.78rem;
		font-weight: 700;
		cursor: pointer;
	}

	.reconfigure-button:hover {
		border-color: var(--fuzzy-color-primary);
	}

	.reconfigure-button:focus-visible {
		outline: 3px solid var(--fuzzy-focus-ring);
		outline-offset: 2px;
	}

	button:focus-visible,
	input:focus-visible,
	h1:focus-visible,
	h2:focus-visible {
		outline: 3px solid var(--fuzzy-focus-ring);
		outline-offset: 2px;
	}

	.startup-spinner {
		width: 24px;
		height: 24px;
		flex: 0 0 auto;
		border: 3px solid var(--fuzzy-color-primary-overlay);
		border-top-color: var(--fuzzy-color-primary);
		border-radius: 999px;
		animation: spin 0.8s linear infinite;
	}

	.window {
		width: 100%;
		height: 100vh;
		min-height: 0;
		padding: 0;
		box-sizing: border-box;
		overflow: hidden;
	}

	.titlebar {
		height: 42px;
		padding: 0 14px 0 18px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		border-radius: 14px 14px 0 0;
		background: var(--fuzzy-color-surface-glass);
		border: 1px solid var(--fuzzy-color-border-overlay);
		border-bottom: none;
	}

	.brand,
	.brand-copy,
	.panel-header,
	.folder-card,
	.scan-heading,
	.selection-summary,
	.action-row {
		display: flex;
	}

	.maintenance-progress-card {
		position: sticky;
		bottom: 12px;
		z-index: 4;
		margin-top: 18px;
		padding: 16px;
		border: 1px solid var(--fuzzy-color-primary-overlay);
		border-radius: 10px;
		background: var(--fuzzy-color-surface-glass);
	}

	.maintenance-progress-heading {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 16px;
	}

	.maintenance-progress-heading strong {
		display: block;
		margin-top: 4px;
		color: var(--fuzzy-color-primary);
	}

	.maintenance-progress-heading > span,
	.maintenance-progress-card > p {
		color: var(--fuzzy-color-text-muted);
		font-size: 0.74rem;
	}

	.maintenance-progress-card > p {
		margin: 10px 0 0;
	}

	.maintenance-progress-track {
		height: 8px;
		margin-top: 12px;
		overflow: hidden;
		border-radius: 999px;
		background: var(--fuzzy-color-primary-overlay);
	}

	.maintenance-progress-track span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: repeating-linear-gradient(
			-45deg,
			var(--fuzzy-color-primary) 0 14px,
			var(--fuzzy-color-primary-strong) 14px 28px
		);
		background-size: 200% 100%;
		animation: progress-flow 1.1s linear infinite;
		transition: width 180ms ease;
	}

	.maintenance-progress-track.indeterminate span {
		animation: maintenance-progress 1.2s ease-in-out infinite alternate;
	}

	@keyframes maintenance-progress {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(333%);
		}
	}

	@keyframes progress-flow {
		from {
			background-position: 0 0;
		}
		to {
			background-position: 56px 0;
		}
	}

	.brand {
		align-items: center;
		gap: 10px;
	}

	.brand-mark {
		width: 18px;
		height: 18px;
		border-radius: 6px;
		object-fit: cover;
		box-shadow: var(--fuzzy-shadow-card);
	}

	.brand-copy {
		align-items: baseline;
		gap: 8px;
		font-size: 0.76rem;
		color: var(--fuzzy-color-text-muted);
	}

	.brand-copy strong {
		color: var(--fuzzy-color-text);
		font-size: 0.82rem;
	}

	.folder-picker {
		display: flex;
		justify-content: center;
		margin-top: 18px;
	}

	.scan-loading-card {
		margin-top: 18px;
		padding: 18px 20px;
		border: 1px solid var(--fuzzy-color-primary-overlay-strong);
		border-radius: 10px;
		background: var(--fuzzy-color-primary-soft);
		color: var(--fuzzy-color-primary-strong);
	}

	.scan-loading-card strong {
		display: block;
		margin-top: 10px;
	}

	.scan-loading-card p {
		margin: 5px 0 0;
		font-size: 0.78rem;
		color: var(--fuzzy-color-text-muted);
	}

	.scan-loading-flow {
		height: 8px;
		overflow: hidden;
		border-radius: 999px;
		background: var(--fuzzy-color-primary-overlay);
	}

	.scan-loading-flow span {
		display: block;
		width: 42%;
		height: 100%;
		border-radius: inherit;
		background: repeating-linear-gradient(
			-45deg,
			var(--fuzzy-color-primary) 0 14px,
			var(--fuzzy-color-primary-strong) 14px 28px
		);
		background-size: 200% 100%;
		animation: scan-flow 1s linear infinite;
	}

	@keyframes scan-flow {
		from {
			transform: translateX(-120%);
			background-position: 0 0;
		}
		to {
			transform: translateX(260%);
			background-position: 56px 0;
		}
	}

	.workspace {
		height: calc(100vh - 42px);
		min-height: 0;
		display: grid;
		grid-template-columns: 248px minmax(0, 1fr);
		border-radius: 0 0 20px 20px;
		overflow: hidden;
		background: var(--fuzzy-color-surface-glass);
		border: 1px solid var(--fuzzy-color-border-overlay);
		box-shadow: 0 26px 54px var(--fuzzy-color-primary-overlay);
	}

	.sidebar {
		padding: 26px 18px;
		background: linear-gradient(
			180deg,
			var(--fuzzy-color-surface-glass),
			var(--fuzzy-color-surface-glass)
		);
		border-right: 1px solid var(--fuzzy-color-border-overlay);
	}

	.sidebar-label {
		margin: 0 0 24px;
		font-size: 0.74rem;
		line-height: 1.6;
		color: var(--fuzzy-color-text-muted);
	}

	.sidebar-note {
		margin: 0;
		font-size: 0.76rem;
		line-height: 1.7;
		color: var(--fuzzy-color-text-muted);
	}

	.content {
		min-width: 0;
		min-height: 0;
		padding: 22px 24px 28px;
		overflow-x: hidden;
		overflow-y: auto;
		background:
			radial-gradient(
				circle at top,
				var(--fuzzy-color-surface-glass),
				transparent 55%
			),
			linear-gradient(
				180deg,
				var(--fuzzy-color-surface-glass),
				var(--fuzzy-color-surface-glass)
			);
	}

	.panel {
		width: min(100%, 980px);
		margin: 22px auto 0;
		padding: 26px 28px 24px;
		border-radius: 12px;
		background: var(--fuzzy-color-surface-glass);
		box-shadow: 0 28px 52px var(--fuzzy-color-primary-overlay);
	}

	.panel-header,
	.folder-card,
	.scan-heading,
	.selection-summary {
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
	}

	h1,
	h2,
	h3,
	p,
	ul {
		margin-top: 0;
	}

	h1 {
		margin-bottom: 8px;
		font-size: 1.8rem;
		letter-spacing: 0;
	}

	h2 {
		font-size: 1.05rem;
	}

	.intro {
		max-width: 640px;
		margin-bottom: 0;
		font-size: 0.82rem;
		line-height: 1.7;
		color: var(--fuzzy-color-text-muted);
	}

	.section-label {
		margin-bottom: 6px;
		font-size: 0.72rem;
		font-weight: 700;
		color: var(--fuzzy-color-text-muted);
		text-transform: uppercase;
	}

	.folder-card,
	.summary-card,
	.empty-state,
	.error-banner,
	.warning-banner,
	.success-banner {
		border-radius: 8px;
	}

	.folder-card {
		margin-top: 20px;
		padding: 18px 20px;
		align-items: center;
		background: linear-gradient(
			180deg,
			var(--fuzzy-color-surface-muted) 0%,
			var(--fuzzy-color-surface-muted) 100%
		);
		border: 1px solid var(--fuzzy-color-border-overlay);
	}

	.folder-card strong {
		font-size: 0.98rem;
		color: var(--fuzzy-color-text);
		word-break: break-word;
	}

	.folder-card small {
		display: block;
		margin-top: 5px;
		color: var(--fuzzy-color-text-muted);
		font-size: 0.74rem;
	}

	.folder-meta {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 10px;
		font-size: 0.76rem;
		color: var(--fuzzy-color-text-muted);
	}

	.scan-section,
	.rule-section,
	.override-section {
		margin-top: 24px;
	}

	.scan-heading h2,
	.selection-summary h2,
	.override-section h2 {
		margin-bottom: 0;
	}

	.scan-count {
		padding: 6px 10px;
		border-radius: 999px;
		background: var(--fuzzy-color-primary-overlay);
		color: var(--fuzzy-color-primary);
		font-size: 0.74rem;
		font-weight: 700;
	}

	.scan-guidance {
		margin: 14px 0 0;
		padding: 12px 14px;
		border: 1px solid var(--fuzzy-color-border-overlay);
		border-radius: 8px;
		background: var(--fuzzy-color-primary-soft);
		color: var(--fuzzy-color-text-muted);
		font-size: 0.78rem;
		line-height: 1.7;
	}

	.pattern-list,
	.override-list {
		margin-top: 14px;
		display: grid;
		gap: 14px;
	}

	.pattern-card {
		width: 100%;
		padding: 18px;
		text-align: left;
		border-radius: 8px;
		border: 1px solid var(--fuzzy-color-border-overlay);
		background: var(--fuzzy-color-surface);
		cursor: pointer;
		transition:
			border-color 0.18s ease,
			box-shadow 0.18s ease,
			transform 0.18s ease;
	}

	.pattern-card {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 18px;
	}

	.pattern-card.selected {
		border-color: var(--fuzzy-color-primary);
		box-shadow: 0 0 0 3px var(--fuzzy-color-primary-overlay);
		transform: translateY(-1px);
	}

	.folder-name-format {
		margin-top: 24px;
		padding: 16px 18px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 18px;
		border: 1px solid var(--fuzzy-color-border-overlay);
		border-radius: 8px;
		background: var(--fuzzy-color-surface-muted);
	}

	.folder-name-format h2 {
		margin: 0;
		font-size: 0.98rem;
	}

	.folder-name-format label {
		display: grid;
		gap: 6px;
		min-width: 220px;
		color: var(--fuzzy-color-text-muted);
		font-size: 0.72rem;
		font-weight: 700;
	}

	.folder-name-format select {
		padding: 9px 11px;
		border: 1px solid var(--fuzzy-color-border);
		border-radius: 8px;
		background: var(--fuzzy-color-surface);
		color: var(--fuzzy-color-text);
		font: inherit;
	}

	.pattern-title-row {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 8px;
	}

	.pattern-title-row h3 {
		margin-bottom: 0;
		font-size: 1rem;
	}

	.pattern-main p {
		margin-bottom: 0;
		font-size: 0.78rem;
		line-height: 1.65;
		color: var(--fuzzy-color-text-muted);
	}

	.pattern-score {
		margin-top: 10px !important;
		color: var(--fuzzy-color-primary) !important;
		font-size: 0.76rem !important;
		font-weight: 800;
	}

	.badge {
		padding: 3px 8px;
		border-radius: 999px;
		background: var(--fuzzy-color-warning-soft);
		color: var(--fuzzy-color-warning);
		font-size: 0.67rem;
		font-weight: 700;
	}

	.override-row {
		padding: 12px 14px;
		display: flex;
		align-items: flex-start;
		gap: 10px;
		border-radius: 8px;
		background: var(--fuzzy-color-surface-muted);
		border: 1px solid var(--fuzzy-color-border-overlay);
		font-size: 0.8rem;
		color: var(--fuzzy-color-text);
	}

	.override-section > div:not(.override-explanation):not(.override-list) {
		display: none;
	}

	.override-section {
		padding: 14px 16px;
		border: 1px solid var(--fuzzy-color-border-overlay);
		border-radius: 10px;
		background: var(--fuzzy-color-surface-muted);
	}

	.override-section summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		cursor: pointer;
		list-style: none;
	}

	.override-section summary::-webkit-details-marker {
		display: none;
	}

	.override-section summary strong {
		font-size: 0.92rem;
	}

	.details-hint {
		color: var(--fuzzy-color-text-muted);
		font-size: 0.74rem;
	}

	.override-row small {
		display: block;
		margin-top: 3px;
		color: var(--fuzzy-color-text-muted);
		line-height: 1.5;
	}

	.override-row select {
		min-width: 190px;
		font-size: 0.76rem;
	}

	.manual-course-row {
		display: flex;
		gap: 8px;
	}

	.manual-course-row input {
		flex: 1;
	}

	.override-help {
		max-width: 680px;
		margin: 8px 0 0;
		font-size: 0.78rem;
		line-height: 1.7;
		color: var(--fuzzy-color-text-muted);
	}

	.selection-summary {
		margin-top: 26px;
	}

	.summary-card {
		margin-top: 14px;
		padding: 16px 18px;
		background: linear-gradient(
			180deg,
			var(--fuzzy-color-warning-soft) 0%,
			var(--fuzzy-color-warning-soft) 100%
		);
		color: var(--fuzzy-color-warning);
		font-size: 0.8rem;
		line-height: 1.7;
	}

	.summary-card strong {
		color: var(--fuzzy-color-warning);
	}

	.change-summary {
		margin-top: 12px;
		padding-top: 12px;
		border-top: 1px solid var(--fuzzy-color-warning-border);
	}

	.change-summary p,
	.change-summary ul {
		margin: 4px 0 0;
	}

	.change-summary ul {
		padding-left: 1.2rem;
	}

	.empty-state,
	.error-banner,
	.warning-banner,
	.success-banner {
		margin-top: 14px;
		padding: 14px 16px;
		font-size: 0.8rem;
	}

	.empty-state {
		background: var(--fuzzy-color-surface-glass);
		border: 1px dashed var(--fuzzy-color-border-overlay);
		color: var(--fuzzy-color-text-muted);
		text-align: center;
	}

	.error-banner {
		background: var(--fuzzy-color-danger-soft);
		border: 1px solid var(--fuzzy-color-danger);
		color: var(--fuzzy-color-danger);
	}

	.warning-banner {
		background: var(--fuzzy-color-warning-soft);
		border: 1px solid var(--fuzzy-color-warning-border);
		color: var(--fuzzy-color-warning);
		line-height: 1.7;
	}

	.success-banner {
		background: var(--fuzzy-color-success-soft);
		border: 1px solid var(--fuzzy-color-success);
		color: var(--fuzzy-color-success);
	}

	.success-banner span {
		display: block;
		margin-top: 4px;
	}

	.action-row {
		margin-top: 18px;
		justify-content: flex-end;
		gap: 10px;
	}

	.ghost-button,
	.primary-button {
		border: none;
		border-radius: 8px;
		font: inherit;
		cursor: pointer;
	}

	.ghost-button:disabled,
	.primary-button:disabled {
		cursor: default;
		opacity: 0.7;
	}

	.ghost-button {
		padding: 8px 10px;
		background: var(--fuzzy-color-surface-glass);
		color: var(--fuzzy-color-primary);
		font-size: 0.74rem;
		font-weight: 700;
	}

	.ghost-button.loading {
		background: var(--fuzzy-color-primary-overlay);
	}

	.reload-configuration-button {
		margin-top: 10px;
	}

	.ghost-button-label {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}

	.spinner {
		width: 12px;
		height: 12px;
		border: 2px solid var(--fuzzy-color-primary-overlay);
		border-top-color: var(--fuzzy-color-primary);
		border-radius: 999px;
		animation: spin 0.8s linear infinite;
	}

	.primary-button {
		padding: 13px 16px;
		background: linear-gradient(
			180deg,
			var(--fuzzy-color-primary) 0%,
			var(--fuzzy-color-primary) 100%
		);
		color: var(--fuzzy-color-surface);
		font-weight: 700;
		box-shadow: 0 14px 28px var(--fuzzy-color-primary-overlay);
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.startup-spinner,
		.spinner,
		.maintenance-progress-track.indeterminate span {
			animation: none;
		}

		.maintenance-progress-track span {
			transition: none;
		}
	}

	@media (max-width: 980px) {
		.workspace {
			grid-template-columns: 1fr;
		}

		.sidebar {
			border-right: none;
			border-bottom: 1px solid var(--fuzzy-color-border-overlay);
		}

		.panel-header,
		.folder-card,
		.scan-heading,
		.selection-summary {
			flex-direction: column;
			align-items: stretch;
		}
	}

	@media (max-width: 720px) {
		.window {
			padding: 0;
		}

		.content {
			padding: 16px;
		}

		.panel {
			padding: 20px 16px 18px;
		}

		.reconfigure-card {
			align-items: stretch;
			flex-direction: column;
			padding: 18px 16px;
		}

		.reconfigure-button {
			width: 100%;
		}

		.pattern-card {
			grid-template-columns: 1fr;
		}

		.folder-name-format {
			align-items: stretch;
			flex-direction: column;
		}

		.folder-name-format label {
			min-width: 0;
		}

		.folder-meta {
			align-items: flex-start;
		}

		.primary-button,
		.action-row {
			width: 100%;
		}

		.brand-copy {
			flex-direction: column;
			align-items: flex-start;
			gap: 0;
		}
	}
</style>
