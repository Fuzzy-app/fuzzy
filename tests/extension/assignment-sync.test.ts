import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
	buildCourseFileReconcilePayload,
	buildMoodleAssignmentSyncPayload,
	parseMoodleDueAt,
} from "../../apps/extension/src/lib/moodle/assignmentSync";
import {
	collectMoodlePageSnapshot,
	detectSubmissionAvailability,
} from "../../apps/extension/src/lib/moodle/pageSnapshot";

describe("Moodle課題の実データ同期", () => {
	test("完全コースページからコース限定差分走査要求を作る", () => {
		const { document } = parseHTML(`
			<html data-courseid="412"><body>
				<main class="course-content">
					<section class="course-section" data-sectionid="0">
						<h1>データベース</h1>
						<div data-academic-year="2026" data-academic-term="前期"></div>
					</section>
				</main>
			</body></html>
		`);
		const snapshot = collectMoodlePageSnapshot(document);
		expect(
			buildCourseFileReconcilePayload(
				snapshot,
				"https://moodle2026.wakayama-u.ac.jp/course/view.php?id=412",
				document,
			),
		).toEqual({
			course: {
				moodleCourseId: "412",
				name: "データベース",
				academicYear: 2026,
				term: "前期",
			},
		});
		expect(
			buildCourseFileReconcilePayload(
				snapshot,
				"https://moodle2026.wakayama-u.ac.jp/mod/resource/view.php?id=10",
				document,
			),
		).toBeNull();
	});

	test("course-moduleの安定IDとJST締切を完全コースsnapshotへ変換する", () => {
		const { document } = parseHTML(`
			<html data-courseid="412">
				<body>
					<main class="course-content">
						<section class="course-section" data-sectionid="0">
							<h1>データベース</h1>
							<div data-academic-year="2026" data-academic-term="2026前期"></div>
							<div class="activity" data-activityname="正規化レポート">
								<a href="https://moodle2026.wakayama-u.ac.jp/mod/assign/view.php?id=701">
									正規化レポート
								</a>
								<span>提出期限: 2026年 7月 30日(木曜日) 23:59</span>
								<span>提出済み</span>
							</div>
							<div class="activity" data-cmid="702" data-activityname="確認小テスト">
								<a href="https://moodle2026.wakayama-u.ac.jp/mod/quiz/view.php">
									確認小テスト
								</a>
								<span>期限: 1月15日 09:00</span>
							</div>
						</section>
					</main>
				</body>
			</html>
		`);
		const snapshot = collectMoodlePageSnapshot(document);
		const payload = buildMoodleAssignmentSyncPayload(
			snapshot,
			"https://moodle2026.wakayama-u.ac.jp/course/view.php?id=412",
			document,
		);

		expect(payload?.course).toMatchObject({
			moodleCourseId: "412",
			name: "データベース",
			academicYear: 2026,
		});
		expect(payload?.assignments).toEqual([
			{
				moodleAssignmentId: "assign:701",
				title: "正規化レポート",
				dueAt: "2026-07-30T23:59:00+09:00",
				source: "moodle_text",
				dueAtStatus: "normal",
				submissionMode: "moodle_auto",
				submitted: true,
				submissionAvailability: "unknown",
				moodleUrl: "https://moodle2026.wakayama-u.ac.jp/mod/assign/view.php?id=701",
			},
			{
				moodleAssignmentId: "quiz:702",
				title: "確認小テスト",
				dueAt: "2027-01-15T09:00:00+09:00",
				source: "moodle_text",
				dueAtStatus: "needs_review",
				submissionMode: "moodle_auto",
				submitted: false,
				submissionAvailability: "unknown",
				moodleUrl: null,
			},
		]);
	});

	test("安定IDがない文面候補は同期対象へ混ぜない", () => {
		const { document } = parseHTML(`
			<html data-courseid="412"><body>
				<main class="course-content">
					<section class="course-section" data-sectionid="0">
						<h1>データベース</h1>
						<p>課題: 名前だけのレポート 提出期限: 2026/07/30 23:59</p>
					</section>
				</main>
			</body></html>
		`);
		const payload = buildMoodleAssignmentSyncPayload(
			collectMoodlePageSnapshot(document),
			"https://moodle.example/course/view.php?id=412",
			document,
		);
		expect(payload?.assignments).toEqual([]);
	});

	test("個別活動ページは完全snapshotとして送らない", () => {
		const { document } = parseHTML(
			'<html data-courseid="412"><body><main class="course-content"><h1>課題</h1></main></body></html>',
		);
		expect(
			buildMoodleAssignmentSyncPayload(
				collectMoodlePageSnapshot(document),
				"https://moodle.example/mod/assign/view.php?id=701",
				document,
			),
		).toBeNull();
	});

	test("単一セクション表示URLは完全snapshotとして送らない", () => {
		const { document } = parseHTML(
			'<html data-courseid="412"><body><main class="course-content"><h1>課題</h1></main></body></html>',
		);
		const snapshot = collectMoodlePageSnapshot(document);
		for (const parameter of ["section=2", "sectionid=91", "showsection=3"]) {
			expect(
				buildMoodleAssignmentSyncPayload(
					snapshot,
					`https://moodle.example/course/view.php?id=412&${parameter}`,
					document,
				),
			).toBeNull();
		}
	});

	test("安定IDを抽出できない課題リンクが1件でもあれば同期を中止する", () => {
		const { document } = parseHTML(`
			<html data-courseid="412"><body>
				<main class="course-content">
					<section class="course-section" data-sectionid="0">
						<h1>データベース</h1>
						<div class="activity" data-activityname="正規化レポート">
							<a href="https://moodle.example/mod/assign/view.php?id=701">正規化レポート</a>
						</div>
						<div class="activity" data-activityname="ID欠落の小テスト">
							<a href="https://moodle.example/mod/quiz/view.php">ID欠落の小テスト</a>
						</div>
					</section>
				</main>
			</body></html>
		`);
		const snapshot = collectMoodlePageSnapshot(document);
		expect(snapshot.assignmentHints.some((hint) => hint.moodleAssignmentId === "assign:701")).toBe(
			true,
		);
		expect(
			buildMoodleAssignmentSyncPayload(
				snapshot,
				"https://moodle.example/course/view.php?id=412",
				document,
			),
		).toBeNull();
	});

	test("ID付き課題を不正値として除外せずsnapshot全体を中止する", () => {
		const title = "課".repeat(513);
		const { document } = parseHTML(`
			<html data-courseid="412"><body>
				<main class="course-content">
					<section class="course-section" data-sectionid="0">
						<h1>データベース</h1>
						<div class="activity" data-activityname="${title}">
							<a href="https://moodle.example/mod/assign/view.php?id=701">${title}</a>
						</div>
					</section>
				</main>
			</body></html>
		`);
		expect(
			buildMoodleAssignmentSyncPayload(
				collectMoodlePageSnapshot(document),
				"https://moodle.example/course/view.php?id=412",
				document,
			),
		).toBeNull();
	});

	test("描画途中またはセクション未描画のDOMは完全snapshotとして送らない", () => {
		for (const courseContent of [
			'<main class="course-content"><h1>データベース</h1></main>',
			`<main class="course-content">
				<section class="course-section" data-sectionid="0">
					<h1>データベース</h1>
					<div data-region="loading-placeholder"></div>
				</section>
			</main>`,
			`<main class="course-content" aria-busy="true">
				<section class="course-section" data-sectionid="0"><h1>データベース</h1></section>
			</main>`,
		]) {
			const { document } = parseHTML(
				`<html data-courseid="412"><body>${courseContent}</body></html>`,
			);
			expect(
				buildMoodleAssignmentSyncPayload(
					collectMoodlePageSnapshot(document),
					"https://moodle.example/course/view.php?id=412",
					document,
				),
			).toBeNull();
		}
	});

	test("描画済みの空コースは空の完全snapshotとして送る", () => {
		const { document } = parseHTML(`
			<html data-courseid="412"><body>
				<main class="course-content">
					<section class="course-section" data-sectionid="0">
						<h1>データベース</h1>
						<p>このセクションに活動はありません。</p>
						<div data-region="loading-placeholder" hidden></div>
					</section>
				</main>
			</body></html>
		`);
		const payload = buildMoodleAssignmentSyncPayload(
			collectMoodlePageSnapshot(document),
			"https://moodle.example/course/view.php?id=412",
			document,
		);
		expect(payload?.assignments).toEqual([]);
	});

	test("明示offset付きISOを受理し、解釈不能な期限は要確認にする", () => {
		expect(
			parseMoodleDueAt("期限: 2026-07-30T23:59:00+09:00", 2026, "2026-07-25T00:00:00Z"),
		).toEqual({ dueAt: "2026-07-30T14:59:00.000Z", dueAtStatus: "normal" });
		expect(
			parseMoodleDueAt("提出期限: 2026年 7月 30日(木曜日) 23:59", 2026, "2026-07-25T00:00:00Z"),
		).toEqual({ dueAt: "2026-07-30T23:59:00+09:00", dueAtStatus: "normal" });
		expect(parseMoodleDueAt("次回授業まで", 2026, "2026-07-25T00:00:00Z")).toEqual({
			dueAt: null,
			dueAtStatus: "needs_review",
		});
	});

	test("提出可否はMoodleの明示文言だけから判定する", () => {
		expect(detectSubmissionAvailability("提出物をアップロードする")).toBe("available");
		expect(detectSubmissionAvailability("この課題は提出を受け付けていません")).toBe("unavailable");
		expect(detectSubmissionAvailability("提出期限: 2026年7月30日")).toBe("unknown");
	});
});
