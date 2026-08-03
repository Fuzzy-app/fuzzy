//! Windows Native Messagingホストのマニフェスト生成とユーザー単位登録。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const DISTRIBUTION_CONFIG_JSON: &str = include_str!("../../distribution.config.json");
const NATIVE_HOST_RESOURCE_PATH: &str = "resources/FuzzyNativeHost.exe";
const NATIVE_MESSAGING_DIRECTORY: &str = "Fuzzy/NativeMessaging";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DistributionConfig {
	native_host_name: String,
	extension_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct NativeHostManifest {
	name: String,
	description: String,
	path: String,
	#[serde(rename = "type")]
	kind: String,
	allowed_origins: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeHostInstallationStatus {
	pub ready: bool,
	pub message: String,
}

impl NativeHostInstallationStatus {
	pub fn ready() -> Self {
		Self {
			ready: true,
			message: "Native Messagingホストを利用できます。".to_string(),
		}
	}

	pub fn failed() -> Self {
		Self {
			ready: false,
			message: "Native Messagingホストを準備できませんでした。Fuzzyを再起動するか、インストーラーで修復してください。".to_string(),
		}
	}
}

pub fn register_from_current_executable() -> Result<(), String> {
	let executable = std::env::current_exe()
		.map_err(|error| format!("実行ファイルの場所を取得できません: {error}"))?;
	let host_path = host_path_for_executable(&executable)?;
	register_native_host(&host_path)
}

pub fn unregister() -> Result<(), String> {
	#[cfg(target_os = "windows")]
	{
		windows::unregister_native_host()
	}
	#[cfg(not(target_os = "windows"))]
	{
		Err("Native Messagingホストの登録はWindows専用です".to_string())
	}
}

fn host_path_for_executable(executable: &Path) -> Result<PathBuf, String> {
	let executable_directory = executable
		.parent()
		.ok_or_else(|| "実行ファイルの親フォルダーを取得できません".to_string())?;
	let host_path = executable_directory.join(NATIVE_HOST_RESOURCE_PATH);
	if !host_path.is_file() {
		return Err(format!(
			"同梱Native Messagingホストが見つかりません: {}",
			host_path.display()
		));
	}
	let canonical_host_path = host_path
		.canonicalize()
		.map_err(|error| format!("Native Messagingホストの場所を解決できません: {error}"))?;
	Ok(without_windows_verbatim_prefix(canonical_host_path))
}

fn without_windows_verbatim_prefix(path: PathBuf) -> PathBuf {
	#[cfg(target_os = "windows")]
	{
		let path_text = path.to_string_lossy();
		if let Some(unc_path) = path_text.strip_prefix(r"\\?\UNC\") {
			return PathBuf::from(format!(r"\\{unc_path}"));
		}
		if let Some(regular_path) = path_text.strip_prefix(r"\\?\") {
			return PathBuf::from(regular_path);
		}
	}
	path
}

fn register_native_host(host_path: &Path) -> Result<(), String> {
	let config = distribution_config()?;
	let manifest_path = manifest_path(&config.native_host_name)?;
	let manifest = create_manifest(&config, host_path)?;
	let manifest_json = serde_json::to_string_pretty(&manifest)
		.map_err(|error| format!("Native Messagingマニフェストを生成できません: {error}"))?;
	let parent = manifest_path
		.parent()
		.ok_or_else(|| "Native Messagingマニフェストの保存先が不正です".to_string())?;
	std::fs::create_dir_all(parent).map_err(|error| {
		format!("Native Messagingマニフェストの保存先を作成できません: {error}")
	})?;
	std::fs::write(&manifest_path, format!("{manifest_json}\n"))
		.map_err(|error| format!("Native Messagingマニフェストを保存できません: {error}"))?;

	#[cfg(target_os = "windows")]
	{
		windows::register_native_host(&config.native_host_name, &manifest_path)
	}
	#[cfg(not(target_os = "windows"))]
	{
		Err("Native Messagingホストの登録はWindows専用です".to_string())
	}
}

fn distribution_config() -> Result<DistributionConfig, String> {
	let config: DistributionConfig = serde_json::from_str(DISTRIBUTION_CONFIG_JSON)
		.map_err(|error| format!("配布設定を読み取れません: {error}"))?;
	validate_host_name(&config.native_host_name)?;
	if config.extension_ids.is_empty()
		|| config
			.extension_ids
			.iter()
			.any(|extension_id| !is_valid_extension_id(extension_id))
	{
		return Err("配布設定の拡張機能IDが不正です".to_string());
	}
	Ok(config)
}

fn create_manifest(
	config: &DistributionConfig,
	host_path: &Path,
) -> Result<NativeHostManifest, String> {
	if !host_path.is_absolute() {
		return Err("Native Messagingホストのパスは絶対パスである必要があります".to_string());
	}
	Ok(NativeHostManifest {
		name: config.native_host_name.clone(),
		description: "Fuzzy Native Messaging Host".to_string(),
		path: host_path.to_string_lossy().into_owned(),
		kind: "stdio".to_string(),
		allowed_origins: config
			.extension_ids
			.iter()
			.map(|extension_id| format!("chrome-extension://{extension_id}/"))
			.collect(),
	})
}

fn manifest_path(native_host_name: &str) -> Result<PathBuf, String> {
	let local_app_data = std::env::var_os("LOCALAPPDATA")
		.ok_or_else(|| "Windowsのアプリデータ保存先を取得できません".to_string())?;
	Ok(PathBuf::from(local_app_data)
		.join(NATIVE_MESSAGING_DIRECTORY)
		.join(format!("{native_host_name}.json")))
}

fn validate_host_name(value: &str) -> Result<(), String> {
	let valid = !value.is_empty()
		&& !value.starts_with('.')
		&& !value.ends_with('.')
		&& !value.contains("..")
		&& value.bytes().all(|byte| {
			byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'.')
		});
	if valid {
		Ok(())
	} else {
		Err("配布設定のNative Messagingホスト名が不正です".to_string())
	}
}

fn is_valid_extension_id(value: &str) -> bool {
	value.len() == 32 && value.bytes().all(|byte| matches!(byte, b'a'..=b'p'))
}

#[cfg(target_os = "windows")]
mod windows {
	use std::io;
	use std::path::{Path, PathBuf};

	use winreg::enums::HKEY_CURRENT_USER;
	use winreg::RegKey;

	use super::{distribution_config, manifest_path, NATIVE_MESSAGING_DIRECTORY};

	const REGISTRY_ROOTS: [&str; 3] = [
		r"Software\Google\Chrome\NativeMessagingHosts",
		r"Software\Chromium\NativeMessagingHosts",
		r"Software\Microsoft\Edge\NativeMessagingHosts",
	];

	pub fn register_native_host(
		native_host_name: &str,
		manifest_path: &Path,
	) -> Result<(), String> {
		let current_user = RegKey::predef(HKEY_CURRENT_USER);
		for registry_root in REGISTRY_ROOTS {
			let key_path = format!(r"{registry_root}\{native_host_name}");
			let (key, _) = current_user.create_subkey(&key_path).map_err(|error| {
				format!("ブラウザのNative Messaging登録を作成できません: {error}")
			})?;
			key.set_value("", &manifest_path.to_string_lossy().as_ref())
				.map_err(|error| {
					format!("ブラウザのNative Messaging登録を保存できません: {error}")
				})?;
		}
		Ok(())
	}

	pub fn unregister_native_host() -> Result<(), String> {
		let config = distribution_config()?;
		let current_user = RegKey::predef(HKEY_CURRENT_USER);
		let mut first_error: Option<io::Error> = None;
		for registry_root in REGISTRY_ROOTS {
			let key_path = format!(r"{registry_root}\{}", config.native_host_name);
			if let Err(error) = current_user.delete_subkey_all(&key_path) {
				if error.kind() != io::ErrorKind::NotFound && first_error.is_none() {
					first_error = Some(error);
				}
			}
		}

		let manifest = manifest_path(&config.native_host_name)?;
		if let Err(error) = std::fs::remove_file(&manifest) {
			if error.kind() != io::ErrorKind::NotFound && first_error.is_none() {
				first_error = Some(error);
			}
		}
		remove_empty_parent_directories(&manifest);

		match first_error {
			Some(error) => Err(format!("Native Messaging登録を削除できません: {error}")),
			None => Ok(()),
		}
	}

	fn remove_empty_parent_directories(manifest: &Path) {
		let Some(native_messaging_directory) = manifest.parent() else {
			return;
		};
		let _ = std::fs::remove_dir(native_messaging_directory);
		if native_messaging_directory.ends_with(PathBuf::from(NATIVE_MESSAGING_DIRECTORY)) {
			if let Some(fuzzy_directory) = native_messaging_directory.parent() {
				let _ = std::fs::remove_dir(fuzzy_directory);
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use std::path::{Path, PathBuf};

	use super::{
		create_manifest, distribution_config, is_valid_extension_id, validate_host_name,
		without_windows_verbatim_prefix,
	};

	#[test]
	fn distribution_config_allows_only_the_fuzzy_extension() {
		let config = distribution_config().unwrap();
		assert_eq!(
			config.native_host_name,
			"jp.ac.wakayama_u.fuzzy.native_host"
		);
		assert_eq!(
			config.extension_ids,
			vec!["edainabflfdaibonfpckomlaocmemagg"]
		);
		let manifest = create_manifest(
			&config,
			Path::new(r"C:\Program Files\Fuzzy\FuzzyNativeHost.exe"),
		)
		.unwrap();
		assert_eq!(
			manifest.allowed_origins,
			vec!["chrome-extension://edainabflfdaibonfpckomlaocmemagg/"]
		);
	}

	#[test]
	fn removes_windows_verbatim_prefix_from_manifest_path() {
		assert_eq!(
			without_windows_verbatim_prefix(PathBuf::from(
				r"\\?\C:\Program Files\Fuzzy\FuzzyNativeHost.exe"
			)),
			PathBuf::from(r"C:\Program Files\Fuzzy\FuzzyNativeHost.exe")
		);
		assert_eq!(
			without_windows_verbatim_prefix(PathBuf::from(
				r"\\?\UNC\server\share\FuzzyNativeHost.exe"
			)),
			PathBuf::from(r"\\server\share\FuzzyNativeHost.exe")
		);
	}

	#[test]
	fn rejects_wildcards_and_invalid_host_names() {
		assert!(!is_valid_extension_id("*"));
		assert!(!is_valid_extension_id("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"));
		assert!(validate_host_name("jp.ac.wakayama_u.fuzzy.native_host").is_ok());
		assert!(validate_host_name("jp..fuzzy").is_err());
	}
}
