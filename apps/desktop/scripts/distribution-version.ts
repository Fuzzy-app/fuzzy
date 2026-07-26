import { resolve } from "node:path";

type PackageJson = {
	version?: unknown;
};

const desktopDirectory = resolve(import.meta.dir, "..");
const repositoryDirectory = resolve(desktopDirectory, "..", "..");

async function jsonVersion(path: string, label: string): Promise<[string, string]> {
	const value = (await Bun.file(path).json()) as PackageJson;
	if (typeof value.version !== "string") {
		throw new Error(`${label}のバージョンを読み取れません。`);
	}
	return [label, value.version];
}

async function cargoVersion(path: string, label: string): Promise<[string, string]> {
	const source = await Bun.file(path).text();
	const packageHeader = source.match(/^\[package\]\s*$/m);
	if (packageHeader?.index === undefined) {
		throw new Error(`${label}のpackageセクションを読み取れません。`);
	}
	const afterHeader = source.slice(packageHeader.index + packageHeader[0].length);
	const nextSection = afterHeader.search(/^\[/m);
	const packageSection = nextSection === -1 ? afterHeader : afterHeader.slice(0, nextSection);
	const version = packageSection.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
	if (!version) {
		throw new Error(`${label}のバージョンを読み取れません。`);
	}
	return [label, version];
}

export async function validateDistributionVersions(): Promise<string> {
	const versions = await Promise.all([
		jsonVersion(resolve(repositoryDirectory, "package.json"), "workspace"),
		jsonVersion(resolve(repositoryDirectory, "apps", "desktop", "package.json"), "desktop"),
		jsonVersion(resolve(repositoryDirectory, "apps", "extension", "package.json"), "extension"),
		jsonVersion(resolve(repositoryDirectory, "apps", "site", "package.json"), "site"),
		jsonVersion(resolve(repositoryDirectory, "packages", "shared", "package.json"), "shared"),
		jsonVersion(
			resolve(repositoryDirectory, "apps", "desktop", "src-tauri", "tauri.conf.json"),
			"Tauri設定",
		),
		cargoVersion(
			resolve(repositoryDirectory, "apps", "desktop", "src-tauri", "Cargo.toml"),
			"desktop crate",
		),
		cargoVersion(
			resolve(repositoryDirectory, "apps", "native-host", "Cargo.toml"),
			"native-host crate",
		),
		cargoVersion(
			resolve(repositoryDirectory, "crates", "engine-core", "Cargo.toml"),
			"engine-core crate",
		),
	]);
	const expected = versions[0]?.[1];
	if (!expected || !/^\d+\.\d+\.\d+$/.test(expected)) {
		throw new Error("配布バージョンがx.y.z形式ではありません。");
	}
	const mismatches = versions.filter(([, version]) => version !== expected);
	if (mismatches.length > 0) {
		throw new Error(
			`配布バージョンが一致しません: ${versions
				.map(([label, version]) => `${label}=${version}`)
				.join(", ")}`,
		);
	}
	return expected;
}
