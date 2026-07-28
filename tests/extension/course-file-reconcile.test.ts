import { describe, expect, test } from "bun:test";
import type { LibraryMaintenanceSummary, ReconcileCourseFilesRequest } from "@fuzzy/shared";
import { createCourseFileReconcileCoordinator } from "../../apps/extension/src/lib/api/courseFileReconcile";

const request: ReconcileCourseFilesRequest = {
	course: {
		moodleCourseId: "412",
		name: "データベース",
		academicYear: 2026,
		term: "前期",
	},
};

const summary: LibraryMaintenanceSummary = {
	scannedFileCount: 2,
	registeredFileCount: 1,
	updatedFileCount: 0,
	indexedFileCount: 1,
	reusedFingerprintCount: 1,
	missingFileCount: 0,
	skippedFileCount: 0,
	warnings: [],
};

describe("コース資料の差分走査調停", () => {
	test("同一コースの同時要求とデバウンス期間内の再要求を1回へまとめる", async () => {
		let callCount = 0;
		let now = 1_000;
		let release: ((value: LibraryMaintenanceSummary) => void) | undefined;
		const client = {
			reconcileCourseFiles() {
				callCount += 1;
				return new Promise<LibraryMaintenanceSummary>((resolve) => {
					release = resolve;
				});
			},
		};
		const coordinator = createCourseFileReconcileCoordinator(300_000, () => now);

		const first = coordinator.reconcile(client, request);
		const concurrent = coordinator.reconcile(client, request);
		expect(callCount).toBe(1);
		release?.(summary);
		expect(await first).toEqual(summary);
		expect(await concurrent).toEqual(summary);

		now += 60_000;
		expect(await coordinator.reconcile(client, request)).toEqual(summary);
		expect(callCount).toBe(1);
	});
});
