use std::path::PathBuf;

fn main() {
	// `cargo test`単独でもTauriのresource検証が先に失敗しないよう、
	// 生成物の中身には触れず、WXTの出力先ディレクトリだけを用意する。
	let extension_output =
		PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../extension/.output/chrome-mv3");
	std::fs::create_dir_all(&extension_output)
		.unwrap_or_else(|error| panic!("拡張機能の出力先を準備できません: {error}"));
	tauri_build::build()
}
