//! 64 bit SimHashの類似度計算とLSH候補抽出。

use std::collections::{BTreeMap, BTreeSet};

use crate::error::{EngineError, EngineResult};
use crate::types::StoredFileFingerprint;

const SIMHASH_BITS: u32 = 64;

/// 64 bit SimHashの一致度。ビットがすべて同じ場合を1.0、すべて異なる場合を0.0とする。
pub fn simhash_similarity(left: u64, right: u64) -> f64 {
	1.0 - f64::from((left ^ right).count_ones()) / f64::from(SIMHASH_BITS)
}

pub(super) fn max_hamming_distance(threshold: f64) -> EngineResult<u32> {
	if !threshold.is_finite() || !(0.0..=1.0).contains(&threshold) {
		return Err(EngineError::InvalidInput {
			field: "threshold".to_string(),
			reason: "0.0以上1.0以下の有限値を指定してください".to_string(),
		});
	}
	Ok(((1.0 - threshold) * f64::from(SIMHASH_BITS)).floor() as u32)
}

pub(super) fn lsh_query_candidates(
	query: u64,
	registered: &[StoredFileFingerprint],
	max_distance: u32,
) -> BTreeSet<usize> {
	if max_distance >= SIMHASH_BITS {
		return registered
			.iter()
			.enumerate()
			.filter_map(|(index, item)| item.simhash.map(|_| index))
			.collect();
	}
	let mut buckets = BTreeMap::<(usize, u64), Vec<usize>>::new();
	for (index, item) in registered.iter().enumerate() {
		let Some(simhash) = item.simhash else {
			continue;
		};
		for key in lsh_band_keys(simhash, max_distance) {
			buckets.entry(key).or_default().push(index);
		}
	}
	let mut candidates = BTreeSet::new();
	for key in lsh_band_keys(query, max_distance) {
		if let Some(indexes) = buckets.get(&key) {
			candidates.extend(indexes);
		}
	}
	candidates
}

pub(super) fn lsh_candidate_pairs(
	fingerprints: &[StoredFileFingerprint],
	max_distance: u32,
) -> BTreeSet<(usize, usize)> {
	let indexes = fingerprints
		.iter()
		.enumerate()
		.filter_map(|(index, fingerprint)| fingerprint.simhash.map(|_| index))
		.collect::<Vec<_>>();
	if max_distance >= SIMHASH_BITS {
		return indexes
			.iter()
			.enumerate()
			.flat_map(|(position, &left)| {
				indexes[position + 1..]
					.iter()
					.map(move |&right| (left, right))
			})
			.collect();
	}

	let mut buckets = BTreeMap::<(usize, u64), Vec<usize>>::new();
	for index in indexes {
		let Some(simhash) = fingerprints[index].simhash else {
			continue;
		};
		for key in lsh_band_keys(simhash, max_distance) {
			buckets.entry(key).or_default().push(index);
		}
	}
	let mut pairs = BTreeSet::new();
	for indexes in buckets.into_values() {
		for (position, &left) in indexes.iter().enumerate() {
			for &right in &indexes[position + 1..] {
				pairs.insert((left.min(right), left.max(right)));
			}
		}
	}
	pairs
}

/// 許容距離を`距離 + 1`個のバンドへ分割する。
///
/// 距離`d`以内の2値には、鳩の巣原理により必ず完全一致するバンドが1つ以上あるため、
/// LSHで閾値内の候補を取りこぼさない。距離64（閾値0）は全件比較へ切り替える。
fn lsh_band_keys(simhash: u64, max_distance: u32) -> Vec<(usize, u64)> {
	let band_count = (max_distance + 1) as usize;
	let base_width = SIMHASH_BITS as usize / band_count;
	let wide_bands = SIMHASH_BITS as usize % band_count;
	let mut keys = Vec::with_capacity(band_count);
	let mut shift = 0;
	for band in 0..band_count {
		let width = base_width + usize::from(band < wide_bands);
		let mask = if width == SIMHASH_BITS as usize {
			u64::MAX
		} else {
			(1_u64 << width) - 1
		};
		keys.push((band, (simhash >> shift) & mask));
		shift += width;
	}
	keys
}
