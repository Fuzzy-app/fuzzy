//! ファイルのストリーミング読み取りとBLAKE3 / SimHash計算。

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

use crate::error::{EngineError, EngineResult};
use crate::types::FileFingerprint;

const BLAKE3_PREFIX: &str = "b3:";
const READ_BUFFER_SIZE: usize = 64 * 1024;
const SIMHASH_BITS: usize = 64;
const SIMHASH_WINDOW_SIZE: usize = 8;
const SIMHASH_SAMPLE_MASK: u64 = 0x0f;
const SIMHASH_FEATURE_SALT: u64 = 0x6a09_e667_f3bc_c909;

pub(super) fn fingerprint_file(path: &Path) -> EngineResult<FileFingerprint> {
	validate_file_path(path)?;
	let file = File::open(path).map_err(|source| path_io(path, source))?;
	let mut reader = BufReader::with_capacity(READ_BUFFER_SIZE, file);
	let mut buffer = vec![0_u8; READ_BUFFER_SIZE];
	let mut blake3 = blake3::Hasher::new();
	let mut simhash = SimHashBuilder::default();
	loop {
		let read = reader
			.read(&mut buffer)
			.map_err(|source| path_io(path, source))?;
		if read == 0 {
			break;
		}
		blake3.update(&buffer[..read]);
		simhash.update(&buffer[..read]);
	}
	let hash_blake3 = format!("{BLAKE3_PREFIX}{}", blake3.finalize().to_hex());
	Ok(FileFingerprint {
		hash_blake3,
		simhash: simhash.finish(),
	})
}

pub(super) fn hash_file(path: &Path) -> EngineResult<String> {
	validate_file_path(path)?;
	let file = File::open(path).map_err(|source| path_io(path, source))?;
	let mut reader = BufReader::with_capacity(READ_BUFFER_SIZE, file);
	let mut hasher = blake3::Hasher::new();
	let mut buffer = vec![0_u8; READ_BUFFER_SIZE];
	loop {
		let read = reader
			.read(&mut buffer)
			.map_err(|source| path_io(path, source))?;
		if read == 0 {
			break;
		}
		hasher.update(&buffer[..read]);
	}
	Ok(format!("{BLAKE3_PREFIX}{}", hasher.finalize().to_hex()))
}

fn validate_file_path(path: &Path) -> EngineResult<()> {
	let metadata = std::fs::metadata(path).map_err(|source| path_io(path, source))?;
	if !metadata.is_file() {
		return Err(EngineError::InvalidPath {
			path: path.display().to_string(),
			reason: "ファイルではありません".to_string(),
		});
	}
	Ok(())
}

fn path_io(path: &Path, source: std::io::Error) -> EngineError {
	EngineError::PathIo {
		path: path.display().to_string(),
		source,
	}
}

#[derive(Debug)]
struct SimHashBuilder {
	weights: [i64; SIMHASH_BITS],
	tail: Vec<u8>,
	selected_features: u64,
	fallback_feature: Option<u64>,
}

impl Default for SimHashBuilder {
	fn default() -> Self {
		Self {
			weights: [0; SIMHASH_BITS],
			tail: Vec::with_capacity(SIMHASH_WINDOW_SIZE - 1),
			selected_features: 0,
			fallback_feature: None,
		}
	}
}

impl SimHashBuilder {
	fn update(&mut self, chunk: &[u8]) {
		let mut bytes = Vec::with_capacity(self.tail.len() + chunk.len());
		bytes.extend_from_slice(&self.tail);
		bytes.extend_from_slice(chunk);

		for window in bytes.windows(SIMHASH_WINDOW_SIZE) {
			let raw = fnv1a_64(window);
			self.fallback_feature.get_or_insert(raw);
			// 内容依存サンプリングにより、大きいファイルでも特徴数を抑えつつ、
			// 途中への挿入・削除で後続特徴の位相がずれる問題を避ける。
			if raw >> 60 == SIMHASH_SAMPLE_MASK {
				self.add_feature(mix64(raw ^ SIMHASH_FEATURE_SALT));
				self.selected_features += 1;
			}
		}

		let tail_length = bytes.len().min(SIMHASH_WINDOW_SIZE - 1);
		self.tail.clear();
		self.tail
			.extend_from_slice(&bytes[bytes.len().saturating_sub(tail_length)..]);
	}

	fn finish(mut self) -> u64 {
		if self.selected_features == 0 {
			let raw = self
				.fallback_feature
				.unwrap_or_else(|| fnv1a_64(&self.tail));
			self.add_feature(mix64(raw ^ SIMHASH_FEATURE_SALT));
		}
		self.weights
			.iter()
			.enumerate()
			.fold(0_u64, |simhash, (bit, &weight)| {
				if weight > 0 {
					simhash | (1_u64 << bit)
				} else {
					simhash
				}
			})
	}

	fn add_feature(&mut self, feature: u64) {
		for (bit, weight) in self.weights.iter_mut().enumerate() {
			if feature & (1_u64 << bit) == 0 {
				*weight -= 1;
			} else {
				*weight += 1;
			}
		}
	}
}

fn fnv1a_64(bytes: &[u8]) -> u64 {
	let mut hash = 0xcbf2_9ce4_8422_2325_u64;
	for byte in bytes {
		hash ^= u64::from(*byte);
		hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
	}
	hash
}

fn mix64(mut value: u64) -> u64 {
	value ^= value >> 30;
	value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
	value ^= value >> 27;
	value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
	value ^ (value >> 31)
}
