//! 拡張機能の実応答を記録・判定するための共有型。
//!
//! ブラウザ名や利用者の自己申告ではなく、Native Messagingで受信した
//! バージョン付きの応答を初期セットアップ完了の根拠にする。

use semver::Version;
use serde::{Deserialize, Serialize};

use crate::{EngineError, EngineResult};

/// 現在のNative Messaging契約バージョン。
pub const EXTENSION_RUNTIME_PROTOCOL_VERSION: u32 = 1;
/// 正常状態として扱う拡張機能の最低バージョン。
pub const MINIMUM_COMPATIBLE_EXTENSION_VERSION: &str = "0.1.0";
/// 最終応答を「最近」とみなす期間（24時間）。
pub const EXTENSION_RUNTIME_RECENT_SECONDS: u64 = 24 * 60 * 60;

/// 拡張機能がnative-hostへ報告する実行情報。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionRuntimeReport {
	/// ブラウザプロファイル内の拡張機能インストールを区別するローカルID。
	pub installation_id: String,
	/// manifest.jsonの拡張機能バージョン。
	pub extension_version: String,
	/// 拡張機能が使用するNative Messaging契約バージョン。
	pub protocol_version: u32,
}

impl ExtensionRuntimeReport {
	/// DBへ保存する前に、境界を越えて受け取った値を検証する。
	pub fn validate(&self) -> EngineResult<()> {
		validate_identifier(&self.installation_id)?;

		if self.extension_version.is_empty() || self.extension_version.len() > 64 {
			return Err(EngineError::InvalidInput {
				field: "extensionVersion".to_string(),
				reason: "1〜64文字で指定してください".to_string(),
			});
		}
		if !self.extension_version.chars().all(|character| {
			character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+')
		}) {
			return Err(EngineError::InvalidInput {
				field: "extensionVersion".to_string(),
				reason: "英数字と . - + だけを使用してください".to_string(),
			});
		}
		if self.protocol_version == 0 {
			return Err(EngineError::InvalidInput {
				field: "protocolVersion".to_string(),
				reason: "1以上で指定してください".to_string(),
			});
		}

		Ok(())
	}
}

fn validate_identifier(value: &str) -> EngineResult<()> {
	if value.is_empty() || value.len() > 128 {
		return Err(EngineError::InvalidInput {
			field: "installationId".to_string(),
			reason: "1〜128文字で指定してください".to_string(),
		});
	}
	if !value
		.chars()
		.all(|character| character.is_ascii_alphanumeric() || character == '-')
	{
		return Err(EngineError::InvalidInput {
			field: "installationId".to_string(),
			reason: "英数字とハイフンだけを使用してください".to_string(),
		});
	}
	Ok(())
}

/// SQLiteに保存した、インストール・バージョン単位の初回／最終応答。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionRuntimeObservation {
	pub installation_id: String,
	pub extension_version: String,
	pub protocol_version: u32,
	pub first_seen_at: String,
	pub last_seen_at: String,
}

/// 初期セットアップ画面から見た現在の応答状態。
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExtensionSetupState {
	Waiting,
	Ready,
	Incompatible,
}

/// Tauriが返す初期セットアップ用の状態。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionSetupStatus {
	pub state: ExtensionSetupState,
	pub observation: Option<ExtensionRuntimeObservation>,
}

impl ExtensionSetupStatus {
	pub fn waiting() -> Self {
		Self {
			state: ExtensionSetupState::Waiting,
			observation: None,
		}
	}
}

/// セットアップ完了後のデスクトップ画面から見た拡張機能の状態。
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ExtensionRecoveryState {
	Missing,
	Ready,
	Stale,
	Incompatible,
}

/// SQLiteの最新応答から算出した、セットアップ完了後の復旧状態。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionRecoveryStatus {
	pub state: ExtensionRecoveryState,
	pub observation: Option<ExtensionRuntimeObservation>,
	pub recent_within_seconds: u64,
}

impl ExtensionRecoveryStatus {
	pub fn missing() -> Self {
		Self {
			state: ExtensionRecoveryState::Missing,
			observation: None,
			recent_within_seconds: EXTENSION_RUNTIME_RECENT_SECONDS,
		}
	}
}

/// 保存された拡張機能バージョンが現在の最低対応版以上かを判定する。
pub fn is_compatible_extension_version(version: &str) -> bool {
	let Ok(candidate) = Version::parse(version) else {
		return false;
	};
	let minimum =
		Version::parse(MINIMUM_COMPATIBLE_EXTENSION_VERSION).expect("最低対応版は有効な形式");
	candidate >= minimum
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn report_validation_accepts_uuid_and_semver() {
		let report = ExtensionRuntimeReport {
			installation_id: "550e8400-e29b-41d4-a716-446655440000".to_string(),
			extension_version: "1.2.3-beta+1".to_string(),
			protocol_version: 1,
		};

		assert!(report.validate().is_ok());
	}

	#[test]
	fn report_validation_rejects_untrusted_values() {
		let mut report = ExtensionRuntimeReport {
			installation_id: "../profile".to_string(),
			extension_version: "1.0.0".to_string(),
			protocol_version: 1,
		};
		assert!(report.validate().is_err());

		report.installation_id = "profile-1".to_string();
		report.extension_version = "1.0.0<script>".to_string();
		assert!(report.validate().is_err());

		report.extension_version = "1.0.0".to_string();
		report.protocol_version = 0;
		assert!(report.validate().is_err());
	}

	#[test]
	fn extension_version_compatibility_uses_minimum_supported_version() {
		assert!(!is_compatible_extension_version("0.0.9"));
		assert!(!is_compatible_extension_version("0.1.0-beta.1"));
		assert!(is_compatible_extension_version("0.1.0"));
		assert!(is_compatible_extension_version("0.2.0-beta.1"));
		assert!(!is_compatible_extension_version("invalid"));
	}
}
