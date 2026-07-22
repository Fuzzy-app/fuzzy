//! DuplicateDetector — BLAKE3完全一致とSimHash / LSHによる類似ファイル検出。
//!
//! SQLiteへの読み書きは永続化層へ委ね、このモジュールはファイルの読み取り、
//! フィンガープリント計算、候補抽出、グループ化だけを担当する。検出したファイルの
//! 削除・移動・変更は行わない。

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use crate::error::{EngineError, EngineResult};
use crate::types::{
	DetectedDuplicateGroup, DetectedDuplicateMember, DuplicateMatch, DuplicateMethod,
	FileFingerprint, StoredFileFingerprint,
};

mod fingerprint;
mod lsh;

use fingerprint::{fingerprint_file, hash_file};
use lsh::{lsh_candidate_pairs, lsh_query_candidates, max_hamming_distance};

pub use lsh::simhash_similarity;

/// 暫定の類似度下限。64 bit SimHashでハミング距離3以下に相当する。
///
/// 実データでの適合率・再現率を評価して確定するまでは、呼び出し側から上書きできる。
pub const DEFAULT_SIMILARITY_THRESHOLD: f64 = 61.0 / 64.0;

/// 重複・類似ファイル検出を担うトレイト。
///
/// 検出結果は保存前の重複通知・類似ファイル提示に使う。削除・統合は行わない。
pub trait DuplicateDetector {
	/// 指定ファイルのBLAKE3と64 bit SimHashを1回の読み取りで計算する。
	fn fingerprint(&self, path: &Path) -> EngineResult<FileFingerprint>;

	/// 指定ファイルのBLAKE3ハッシュを計算し、登録済みファイルとの完全一致を返す。
	fn find_exact(&self, path: &Path) -> EngineResult<Vec<DuplicateMatch>>;

	/// SimHash / LSHにより、登録済みファイルとの類似候補を類似度の降順で返す。
	///
	/// `threshold` は0.0〜1.0の類似度下限。完全一致は常に含める。
	fn find_similar(&self, path: &Path, threshold: f64) -> EngineResult<Vec<DuplicateMatch>>;

	/// 保存済みフィンガープリントを完全一致・類似グループへまとめる。
	fn detect_groups(
		&self,
		fingerprints: &[StoredFileFingerprint],
		threshold: f64,
	) -> EngineResult<Vec<DetectedDuplicateGroup>>;
}

/// ファイル内容だけを使う既定実装。
///
/// `registered`は保存前照合用の読み取り専用スナップショットであり、SQLiteの正本を
/// 置き換えない。DB全体の再計算では[`DuplicateDetector::detect_groups`]へトランザクション
/// 内で読み込んだフィンガープリントを明示的に渡す。
#[derive(Debug, Default)]
pub struct DefaultDuplicateDetector {
	registered: Vec<StoredFileFingerprint>,
}

impl DefaultDuplicateDetector {
	/// 保存前照合に使う登録済みフィンガープリントから検出器を構成する。
	///
	/// 同じファイルIDが複数回渡された場合は最後の値を採用し、ID順に保持する。
	pub fn new(
		registered: impl IntoIterator<Item = StoredFileFingerprint>,
	) -> DefaultDuplicateDetector {
		let registered = registered
			.into_iter()
			.map(|fingerprint| (fingerprint.file_id, fingerprint))
			.collect::<BTreeMap<_, _>>()
			.into_values()
			.collect();
		Self { registered }
	}

	/// 構成時に渡した登録済みファイルをグループ化する。
	pub fn detect_registered_groups(
		&self,
		threshold: f64,
	) -> EngineResult<Vec<DetectedDuplicateGroup>> {
		self.detect_groups(&self.registered, threshold)
	}
}

impl DuplicateDetector for DefaultDuplicateDetector {
	fn fingerprint(&self, path: &Path) -> EngineResult<FileFingerprint> {
		fingerprint_file(path)
	}

	fn find_exact(&self, path: &Path) -> EngineResult<Vec<DuplicateMatch>> {
		let hash_blake3 = hash_file(path)?;
		Ok(self
			.registered
			.iter()
			.filter(|candidate| candidate.hash_blake3 == hash_blake3)
			.map(|candidate| DuplicateMatch {
				file_id: candidate.file_id,
				exact: true,
				similarity: 1.0,
			})
			.collect())
	}

	fn find_similar(&self, path: &Path, threshold: f64) -> EngineResult<Vec<DuplicateMatch>> {
		let max_distance = max_hamming_distance(threshold)?;
		let fingerprint = fingerprint_file(path)?;
		let candidate_indexes =
			lsh_query_candidates(fingerprint.simhash, &self.registered, max_distance);
		let mut matches = BTreeMap::new();

		for candidate in &self.registered {
			if candidate.hash_blake3 == fingerprint.hash_blake3 {
				matches.insert(
					candidate.file_id,
					DuplicateMatch {
						file_id: candidate.file_id,
						exact: true,
						similarity: 1.0,
					},
				);
			}
		}
		for index in candidate_indexes {
			let candidate = &self.registered[index];
			let Some(candidate_simhash) = candidate.simhash else {
				continue;
			};
			let similarity = simhash_similarity(fingerprint.simhash, candidate_simhash);
			if similarity >= threshold {
				matches.entry(candidate.file_id).or_insert(DuplicateMatch {
					file_id: candidate.file_id,
					exact: false,
					similarity,
				});
			}
		}

		let mut matches = matches.into_values().collect::<Vec<_>>();
		matches.sort_by(|left, right| {
			right
				.similarity
				.total_cmp(&left.similarity)
				.then_with(|| right.exact.cmp(&left.exact))
				.then_with(|| left.file_id.cmp(&right.file_id))
		});
		Ok(matches)
	}

	fn detect_groups(
		&self,
		fingerprints: &[StoredFileFingerprint],
		threshold: f64,
	) -> EngineResult<Vec<DetectedDuplicateGroup>> {
		let max_distance = max_hamming_distance(threshold)?;
		validate_fingerprints(fingerprints)?;

		let mut exact_by_hash = BTreeMap::<&str, Vec<i64>>::new();
		for fingerprint in fingerprints {
			exact_by_hash
				.entry(&fingerprint.hash_blake3)
				.or_default()
				.push(fingerprint.file_id);
		}
		let mut groups = exact_by_hash
			.into_values()
			.filter(|members| members.len() >= 2)
			.map(|mut members| {
				members.sort_unstable();
				DetectedDuplicateGroup {
					method: DuplicateMethod::Exact,
					members: members
						.into_iter()
						.map(|file_id| DetectedDuplicateMember {
							file_id,
							similarity: 1.0,
						})
						.collect(),
				}
			})
			.collect::<Vec<_>>();

		let candidate_pairs = lsh_candidate_pairs(fingerprints, max_distance);
		let mut accepted_edges = Vec::new();
		let mut sets = DisjointSets::new(fingerprints.len());
		for (left, right) in candidate_pairs {
			let (Some(left_simhash), Some(right_simhash)) =
				(fingerprints[left].simhash, fingerprints[right].simhash)
			else {
				continue;
			};
			// 完全一致はexactグループだけで提示し、同じペアをsimilarへ重複登録しない。
			if fingerprints[left].hash_blake3 == fingerprints[right].hash_blake3 {
				continue;
			}
			let similarity = simhash_similarity(left_simhash, right_simhash);
			if similarity >= threshold {
				sets.union(left, right);
				accepted_edges.push((left, right, similarity));
			}
		}

		let mut components = BTreeMap::<usize, Vec<usize>>::new();
		for index in 0..fingerprints.len() {
			let root = sets.find(index);
			components.entry(root).or_default().push(index);
		}
		let mut closest_similarity = vec![0.0_f64; fingerprints.len()];
		for &(left, right, similarity) in &accepted_edges {
			closest_similarity[left] = closest_similarity[left].max(similarity);
			closest_similarity[right] = closest_similarity[right].max(similarity);
		}
		for component in components.into_values().filter(|group| group.len() >= 2) {
			let mut members = component
				.into_iter()
				.map(|index| DetectedDuplicateMember {
					file_id: fingerprints[index].file_id,
					// 連結成分内で最も近い相手との類似度。全メンバーが閾値以上になる。
					similarity: closest_similarity[index],
				})
				.collect::<Vec<_>>();
			members.sort_by_key(|member| member.file_id);
			groups.push(DetectedDuplicateGroup {
				method: DuplicateMethod::Similar,
				members,
			});
		}

		groups.sort_by(|left, right| {
			left.method
				.cmp(&right.method)
				.then_with(|| left.members[0].file_id.cmp(&right.members[0].file_id))
		});
		Ok(groups)
	}
}

fn validate_fingerprints(fingerprints: &[StoredFileFingerprint]) -> EngineResult<()> {
	let mut file_ids = BTreeSet::new();
	for fingerprint in fingerprints {
		if !file_ids.insert(fingerprint.file_id) {
			return Err(EngineError::Internal {
				message: format!(
					"重複検出の入力にファイルID {} が複数あります",
					fingerprint.file_id
				),
			});
		}
		if fingerprint.hash_blake3.trim().is_empty() {
			return Err(EngineError::Internal {
				message: format!(
					"ファイルID {} のBLAKE3ハッシュが空です",
					fingerprint.file_id
				),
			});
		}
	}
	Ok(())
}

#[derive(Debug)]
struct DisjointSets {
	parents: Vec<usize>,
	ranks: Vec<u8>,
}

impl DisjointSets {
	fn new(length: usize) -> Self {
		Self {
			parents: (0..length).collect(),
			ranks: vec![0; length],
		}
	}

	fn find(&mut self, index: usize) -> usize {
		if self.parents[index] != index {
			self.parents[index] = self.find(self.parents[index]);
		}
		self.parents[index]
	}

	fn union(&mut self, left: usize, right: usize) {
		let left_root = self.find(left);
		let right_root = self.find(right);
		if left_root == right_root {
			return;
		}
		match self.ranks[left_root].cmp(&self.ranks[right_root]) {
			std::cmp::Ordering::Less => self.parents[left_root] = right_root,
			std::cmp::Ordering::Greater => self.parents[right_root] = left_root,
			std::cmp::Ordering::Equal => {
				self.parents[right_root] = left_root;
				self.ranks[left_root] += 1;
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use std::sync::atomic::{AtomicU64, Ordering};

	use super::*;

	static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

	fn temporary_file(name: &str, contents: &[u8]) -> std::path::PathBuf {
		let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
		let directory = std::env::temp_dir().join(format!(
			"fuzzy-duplicate-test-{}-{sequence}",
			std::process::id()
		));
		std::fs::create_dir_all(&directory).unwrap();
		let path = directory.join(name);
		std::fs::write(&path, contents).unwrap();
		path
	}

	fn remove_temporary_file(path: &Path) {
		if let Some(directory) = path.parent() {
			let _ = std::fs::remove_dir_all(directory);
		}
	}

	fn stored(file_id: i64, hash: &str, simhash: Option<u64>) -> StoredFileFingerprint {
		StoredFileFingerprint {
			file_id,
			hash_blake3: hash.to_string(),
			simhash,
		}
	}

	#[test]
	fn blake3_fingerprint_detects_an_exact_copy() {
		let original = temporary_file("第4回_正規化.pdf", b"normalization lecture material");
		let copy = temporary_file("第4回_正規化(1).pdf", b"normalization lecture material");
		let fingerprint = DefaultDuplicateDetector::default()
			.fingerprint(&original)
			.unwrap();
		let detector = DefaultDuplicateDetector::new([stored(
			3,
			&fingerprint.hash_blake3,
			Some(fingerprint.simhash),
		)]);

		let matches = detector.find_exact(&copy).unwrap();

		assert_eq!(fingerprint.hash_blake3.len(), "b3:".len() + 64);
		assert!(fingerprint.hash_blake3.starts_with("b3:"));
		assert_eq!(
			matches,
			vec![DuplicateMatch {
				file_id: 3,
				exact: true,
				similarity: 1.0,
			}]
		);
		remove_temporary_file(&original);
		remove_temporary_file(&copy);
	}

	#[test]
	fn similar_content_has_a_higher_score_than_unrelated_content() {
		let base = (1..=200)
			.map(|section| {
				format!(
					"第{section}項 データベース正規化の講義資料です。第一正規形から第三正規形までを説明します。\n"
				)
			})
			.collect::<String>();
		let similar = base.replacen("第三正規形", "ボイスコッド正規形", 1);
		let unrelated = "認知科学と知覚心理学についての演習課題です。\n".repeat(200);
		let base_path = temporary_file("base.txt", base.as_bytes());
		let similar_path = temporary_file("similar.txt", similar.as_bytes());
		let unrelated_path = temporary_file("unrelated.txt", unrelated.as_bytes());
		let detector = DefaultDuplicateDetector::default();

		let base_hash = detector.fingerprint(&base_path).unwrap().simhash;
		let similar_hash = detector.fingerprint(&similar_path).unwrap().simhash;
		let unrelated_hash = detector.fingerprint(&unrelated_path).unwrap().simhash;

		let similar_score = simhash_similarity(base_hash, similar_hash);
		let unrelated_score = simhash_similarity(base_hash, unrelated_hash);
		assert!(
			similar_score >= DEFAULT_SIMILARITY_THRESHOLD,
			"類似内容のスコア: {similar_score}"
		);
		assert!(
			unrelated_score < DEFAULT_SIMILARITY_THRESHOLD,
			"無関係内容のスコア: {unrelated_score}"
		);
		assert!(similar_score > unrelated_score);
		remove_temporary_file(&base_path);
		remove_temporary_file(&similar_path);
		remove_temporary_file(&unrelated_path);
	}

	#[test]
	fn find_similar_returns_exact_and_near_matches_in_score_order() {
		let path = temporary_file("第4回_正規化.pdf", b"normalization lecture material");
		let query = DefaultDuplicateDetector::default()
			.fingerprint(&path)
			.unwrap();
		let detector = DefaultDuplicateDetector::new([
			stored(2, "b3:near", Some(query.simhash ^ 1)),
			stored(3, &query.hash_blake3, None),
			stored(4, "b3:far", Some(query.simhash ^ 0xffff)),
		]);

		let matches = detector
			.find_similar(&path, DEFAULT_SIMILARITY_THRESHOLD)
			.unwrap();

		assert_eq!(
			matches,
			vec![
				DuplicateMatch {
					file_id: 3,
					exact: true,
					similarity: 1.0,
				},
				DuplicateMatch {
					file_id: 2,
					exact: false,
					similarity: 63.0 / 64.0,
				},
			]
		);
		remove_temporary_file(&path);
	}

	#[test]
	fn lsh_groups_near_hashes_without_missing_the_threshold_boundary() {
		let base = 0x1234_5678_9abc_def0_u64;
		let three_bands_differ = (1_u64 << 0) | (1_u64 << 16) | (1_u64 << 32);
		let fingerprints = vec![
			stored(1, "b3:a", Some(base)),
			stored(2, "b3:b", Some(base ^ three_bands_differ)),
			stored(3, "b3:c", Some(base ^ 0xffff)),
			stored(4, "b3:exact", Some(0xaaaa_aaaa_aaaa_aaaa)),
			stored(5, "b3:exact", Some(0xaaaa_aaaa_aaaa_aaaa)),
		];

		let groups = DefaultDuplicateDetector::default()
			.detect_groups(&fingerprints, DEFAULT_SIMILARITY_THRESHOLD)
			.unwrap();

		assert_eq!(groups.len(), 2);
		assert_eq!(groups[0].method, DuplicateMethod::Exact);
		assert_eq!(
			groups[0]
				.members
				.iter()
				.map(|member| member.file_id)
				.collect::<Vec<_>>(),
			vec![4, 5]
		);
		assert_eq!(groups[1].method, DuplicateMethod::Similar);
		assert_eq!(
			groups[1]
				.members
				.iter()
				.map(|member| member.file_id)
				.collect::<Vec<_>>(),
			vec![1, 2]
		);
		assert!(groups[1]
			.members
			.iter()
			.all(|member| member.similarity >= DEFAULT_SIMILARITY_THRESHOLD));
	}

	#[test]
	fn exact_pairs_are_not_repeated_as_similar_groups() {
		let fingerprints = vec![
			stored(3, "b3:same", Some(42)),
			stored(9, "b3:same", Some(42)),
		];

		let groups = DefaultDuplicateDetector::default()
			.detect_groups(&fingerprints, 1.0)
			.unwrap();

		assert_eq!(groups.len(), 1);
		assert_eq!(groups[0].method, DuplicateMethod::Exact);
	}

	#[test]
	fn rejects_invalid_thresholds_and_duplicate_file_ids() {
		let duplicate_ids = vec![stored(1, "b3:a", Some(1)), stored(1, "b3:b", Some(2))];

		assert!(matches!(
			DefaultDuplicateDetector::default().detect_groups(&[], f64::NAN),
			Err(EngineError::InvalidInput { .. })
		));
		assert!(matches!(
			DefaultDuplicateDetector::default().detect_groups(&duplicate_ids, 0.9),
			Err(EngineError::Internal { .. })
		));
	}

	#[test]
	fn empty_files_have_a_deterministic_fingerprint() {
		let first = temporary_file("empty-a.txt", b"");
		let second = temporary_file("empty-b.txt", b"");

		let first_fingerprint = DefaultDuplicateDetector::default()
			.fingerprint(&first)
			.unwrap();
		let second_fingerprint = DefaultDuplicateDetector::default()
			.fingerprint(&second)
			.unwrap();

		assert_eq!(first_fingerprint, second_fingerprint);
		remove_temporary_file(&first);
		remove_temporary_file(&second);
	}
}
