import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
	buildCourseFileReconcilePayload,
	buildMoodleAssignmentSyncPayload,
	contextualMoodleCourseId,
	parseMoodleDueAt,
} from "../../apps/extension/src/lib/moodle/assignmentSync";
import {
	collectMoodlePageSnapshot,
	detectSubmissionAvailability,
	isMoodleSiteTitle,
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
				moodleCourseId: "moodle:moodle2026.wakayama-u.ac.jp:2026:412",
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
			moodleCourseId: "moodle:moodle2026.wakayama-u.ac.jp:2026:412",
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

	test("年度表示のない審査専用QAコースは2026年度として同期する", () => {
		const { document } = parseHTML(`
			<html data-courseid="136">
				<body>
					<main class="course-content">
						<section class="course-section" data-sectionid="0">
							<h1>Fuzzy 動作確認コース</h1>
							<div class="activity" data-activityname="第1回レポート">
								<a href="https://fuzzy-qa-2026.moodlecloud.com/mod/assign/view.php?id=701">
									第1回レポート
								</a>
								<span>提出期限: 8月11日 23:59</span>
							</div>
						</section>
					</main>
				</body>
			</html>
		`);
		const snapshot = collectMoodlePageSnapshot(document);
		const pageUrl = "https://fuzzy-qa-2026.moodlecloud.com/course/view.php?id=136";

		expect(snapshot.academicYear).toBeNull();
		expect(buildMoodleAssignmentSyncPayload(snapshot, pageUrl, document)).toMatchObject({
			course: {
				moodleCourseId: "moodle:fuzzy-qa-2026.moodlecloud.com:2026:136",
				name: "Fuzzy 動作確認コース",
				academicYear: 2026,
			},
			assignments: [
				{
					moodleAssignmentId: "assign:701",
					dueAt: "2026-08-11T23:59:00+09:00",
					moodleUrl: "https://fuzzy-qa-2026.moodlecloud.com/mod/assign/view.php?id=701",
				},
			],
		});
		expect(buildCourseFileReconcilePayload(snapshot, pageUrl, document)).toEqual({
			course: {
				moodleCourseId: "moodle:fuzzy-qa-2026.moodlecloud.com:2026:136",
				name: "Fuzzy 動作確認コース",
				academicYear: 2026,
				term: null,
			},
		});
	});

	test("MoodleCloud 5.2の英語表示から2件の課題とJST締切を同期する", () => {
		const { document } = parseHTML(`
			<html data-courseid="9"><body>
				<main class="course-content">
					<section class="course-section" data-sectionid="0">
						<h1>Fuzzy 動作確認コース</h1>
						<div class="activity activity-wrapper" data-activityname="第1回レポート">
							<a href="https://fuzzy-qa-2026.moodlecloud.com/mod/assign/view.php?id=41">第1回レポート</a>
							<span>Due: Tuesday, 11 August 2026, 11:59 PM</span>
						</div>
						<div class="activity activity-wrapper" data-activityname="第2回レポート">
							<a href="https://fuzzy-qa-2026.moodlecloud.com/mod/assign/view.php?id=42">第2回レポート</a>
							<span>Due: Tuesday, 18 August 2026, 11:59 PM</span>
						</div>
					</section>
				</main>
			</body></html>
		`);
		const pageUrl = "https://fuzzy-qa-2026.moodlecloud.com/course/view.php?id=9";
		const payload = buildMoodleAssignmentSyncPayload(
			collectMoodlePageSnapshot(document),
			pageUrl,
			document,
		);

		expect(payload?.assignments).toMatchObject([
			{
				moodleAssignmentId: "assign:41",
				title: "第1回レポート",
				dueAt: "2026-08-11T23:59:00+09:00",
				dueAtStatus: "normal",
			},
			{
				moodleAssignmentId: "assign:42",
				title: "第2回レポート",
				dueAt: "2026-08-18T23:59:00+09:00",
				dueAtStatus: "normal",
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
		expect(payload).toBeNull();
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
		expect(payload).toBeNull();
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

	test("英語表示の12時間制締切をJSTとして解釈する", () => {
		expect(
			parseMoodleDueAt("Due: Tuesday, 11 August 2026, 11:59 PM", 2026, "2026-08-04T00:00:00Z"),
		).toEqual({ dueAt: "2026-08-11T23:59:00+09:00", dueAtStatus: "normal" });
		expect(
			parseMoodleDueAt("Due: August 12, 2026, 12:05 AM", 2026, "2026-08-04T00:00:00Z"),
		).toEqual({ dueAt: "2026-08-12T00:05:00+09:00", dueAtStatus: "normal" });
	});

	test("提出可否はMoodleの明示文言だけから判定する", () => {
		expect(detectSubmissionAvailability("提出物をアップロードする")).toBe("available");
		expect(detectSubmissionAvailability("この課題は提出を受け付けていません")).toBe("unavailable");
		expect(detectSubmissionAvailability("提出期限: 2026年7月30日")).toBe("unknown");
		expect(detectSubmissionAvailability("提出期限は過ぎています")).toBe("unknown");
	});
});
describe("Moodle course identity isolation", () => {
	test("Moodle site title is not treated as a course name", () => {
		expect(isMoodleSiteTitle("【和歌山大学】 Moodle2026")).toBe(true);
		expect(isMoodleSiteTitle("情報システム実験")).toBe(false);
	});

	test("course ids include Moodle host and academic year when the page URL is known", () => {
		expect(
			contextualMoodleCourseId(
				{ moodleCourseId: "412", academicYear: 2025 } as never,
				"https://moodle2025.wakayama-u.ac.jp/2025/course/view.php?id=412",
			),
		).toBe("moodle:moodle2025.wakayama-u.ac.jp:2025:412");
		expect(
			contextualMoodleCourseId(
				{ moodleCourseId: "412", academicYear: 2026 } as never,
				"https://moodle2026.wakayama-u.ac.jp/2026/course/view.php?id=412",
			),
		).not.toBe("moodle:moodle2025.wakayama-u.ac.jp:2025:412");
	});

	test("does not create a contextual course id when the academic year is unknown", () => {
		for (const pageUrl of [
			"https://moodle.example/course/view.php?id=412",
			"https://fuzzy-qa-2027.moodlecloud.com/course/view.php?id=412",
			"http://fuzzy-qa-2026.moodlecloud.com/course/view.php?id=412",
			"https://reviewer@fuzzy-qa-2026.moodlecloud.com/course/view.php?id=412",
			"https://fuzzy-qa-2026.moodlecloud.com:444/course/view.php?id=412",
			"https://moodle2026.wakayama-u.ac.jp/course/view.php?id=412",
		]) {
			expect(
				contextualMoodleCourseId({ moodleCourseId: "412", academicYear: null } as never, pageUrl),
			).toBeNull();
		}
	});
});
