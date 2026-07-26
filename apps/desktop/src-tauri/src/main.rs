// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
	if let Some(command) = std::env::args().nth(1) {
		let result = match command.as_str() {
			"--register-native-host" => desktop_lib::register_native_host(),
			"--unregister-native-host" => desktop_lib::unregister_native_host(),
			_ => {
				desktop_lib::run();
				return;
			}
		};
		if let Err(error) = result {
			eprintln!("{error}");
			std::process::exit(1);
		}
		return;
	}
	desktop_lib::run()
}
