<script lang="ts">
	// 疎通確認用の最小画面（issue #34）。
	// createApiClient() が native-host への接続を試み、応答が無ければ
	// MockApiClient（サンプルデータ）に自動フォールバックする（packages/shared/src/api/）。
	// 本格的な画面（資料保存UI・締切ハブ等）はPhase2の各issueでこの雛形を置き換える。
	import { createApiClient, type DashboardSummary } from "@fuzzy/shared";

	interface DashboardView {
		mode: "native" | "mock";
		summary: DashboardSummary;
	}

	async function loadDashboard(): Promise<DashboardView> {
		const api = await createApiClient();
		return { mode: api.mode, summary: await api.getDashboard() };
	}

	const dashboard = loadDashboard();
</script>

<main>
	<h1>Fuzzy 疎通確認</h1>

	{#await dashboard}
		<p>読み込み中…</p>
	{:then view}
		<p class="mode" data-mode={view.mode}>
			接続モード: <strong
				>{view.mode === "native"
					? "native-host接続中"
					: "サンプルデータ（mock）"}</strong
			>
		</p>
		<p>
			ファイル {view.summary.totalFiles} 件 ／ ルール違反 {view.summary
				.totalViolations} 件 ／ 直近の締切 {view.summary.upcomingDeadlineCount} 件
		</p>
		<table>
			<thead>
				<tr><th>コース</th><th>ファイル</th><th>違反</th><th>次の締切</th></tr>
			</thead>
			<tbody>
				{#each view.summary.courses as course (course.courseId)}
					<tr>
						<td>{course.courseName}</td>
						<td>{course.fileCount}</td>
						<td>{course.violationCount}</td>
						<td>{course.nextDueAt ?? "-"}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{:catch error}
		<p class="error">
			ダッシュボードの取得に失敗しました: {error?.message ?? error}
		</p>
	{/await}
</main>

<style>
	main {
		min-width: 420px;
		padding: 12px;
		font-family: system-ui, sans-serif;
	}
	h1 {
		font-size: 1.1rem;
	}
	.mode[data-mode="mock"] strong {
		color: #b45309;
	}
	.mode[data-mode="native"] strong {
		color: #15803d;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
	}
	th,
	td {
		border: 1px solid #d4d4d8;
		padding: 4px 6px;
		text-align: left;
	}
	.error {
		color: #b91c1c;
	}
</style>
