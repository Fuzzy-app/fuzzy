use std::path::PathBuf;
use std::time::Instant;

use engine_core::pattern::{FrequencyPatternEstimator, PatternEstimator};
use engine_core::types::{FileEntry, SavedFileRegistration};
use engine_core::Database;

const FILE_COUNT: usize = 40_000;
const BATCH_SIZE: usize = 256;

#[test]
fn forty_thousand_file_roles_and_batched_metadata_are_deterministic() {
	let entries = (0..FILE_COUNT)
		.map(|index| {
			let course = index % 100;
			let relative_path =
				PathBuf::from(format!("2026年度/1Q/科目{course:03}/資料{index:05}.bin"));
			FileEntry {
				path: PathBuf::from("C:/fuzzy-issue114-benchmark").join(&relative_path),
				file_name: format!("資料{index:05}.bin"),
				relative_path,
				size: 1,
				modified_at: Some(index as i64 + 1),
			}
		})
		.collect::<Vec<_>>();

	let inference_started = Instant::now();
	let guesses = FrequencyPatternEstimator.estimate(&entries).unwrap();
	let inference_elapsed = inference_started.elapsed();
	assert_eq!(guesses.len(), 1);
	assert_eq!(guesses[0].directory_template, "{year}年度/{term}/{course}");
	assert_eq!(guesses[0].matched_count, FILE_COUNT);
	assert_eq!(guesses[0].evaluated_count, FILE_COUNT);

	let registrations = entries
		.iter()
		.map(|entry| {
			(
				SavedFileRegistration {
					course_id: None,
					section_no: None,
					moodle_file_id: None,
					original_name: entry.file_name.clone(),
					saved_path: entry.path.clone(),
					size_bytes: entry.size as i64,
					mime_type: None,
					hash_blake3: format!("b3:{:064x}", entry.modified_at.unwrap()),
					simhash: entry.modified_at.unwrap() as u64,
				},
				entry.modified_at,
			)
		})
		.collect::<Vec<_>>();
	let mut database = Database::open_in_memory().unwrap();

	let initial_started = Instant::now();
	let mut inserted = 0;
	for batch in registrations.chunks(BATCH_SIZE) {
		inserted += database
			.upsert_scanned_files_observed(batch)
			.unwrap()
			.into_iter()
			.filter(|result| result.inserted)
			.count();
	}
	let initial_elapsed = initial_started.elapsed();
	assert_eq!(inserted, FILE_COUNT);

	let repeat_started = Instant::now();
	let mut unchanged = 0;
	for batch in registrations.chunks(BATCH_SIZE) {
		unchanged += database
			.upsert_scanned_files_observed(batch)
			.unwrap()
			.into_iter()
			.filter(|result| !result.inserted && !result.updated)
			.count();
	}
	let repeat_elapsed = repeat_started.elapsed();
	assert_eq!(unchanged, FILE_COUNT);

	let observation_started = Instant::now();
	let observations = database.scanned_file_observations(None).unwrap();
	let observation_elapsed = observation_started.elapsed();
	assert_eq!(observations.len(), FILE_COUNT);

	eprintln!(
		"issue114 benchmark: inference={inference_elapsed:?}, initial_metadata={initial_elapsed:?}, repeated_metadata={repeat_elapsed:?}, bulk_observation_load={observation_elapsed:?}"
	);
}
