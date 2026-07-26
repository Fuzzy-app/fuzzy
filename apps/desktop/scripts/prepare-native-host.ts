import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { cargoTargetDirectory } from "./cargo-target";

const repositoryDirectory = resolve(import.meta.dir, "..", "..", "..");
const resourceDirectory = resolve(import.meta.dir, "..", "src-tauri", "resources");
const stagedNativeHostPath = resolve(resourceDirectory, "FuzzyNativeHost.exe");
const legacyStagedNativeHostPath = resolve(resourceDirectory, "native-host.exe");

export async function prepareNativeHost(release: boolean): Promise<string> {
	if (process.platform !== "win32") {
		throw new Error("Windows配布用native-hostはWindows上でビルドしてください。");
	}
	const args = ["cargo", "build", "--locked", "--package", "native-host"];
	if (release) args.push("--release");
	console.log(`Fuzzy Native Messagingホストを${release ? "リリース" : "デバッグ"}ビルドします。`);
	const build = Bun.spawn(args, {
		cwd: repositoryDirectory,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await build.exited;
	if (exitCode !== 0) {
		throw new Error(`native-hostのビルドに失敗しました（終了コード: ${exitCode}）。`);
	}

	const targetDirectory = await cargoTargetDirectory(repositoryDirectory);
	const source = resolve(targetDirectory, release ? "release" : "debug", "native-host.exe");
	const sourceStat = await stat(source);
	if (!sourceStat.isFile() || sourceStat.size === 0) {
		throw new Error("ビルド済みnative-host.exeが見つかりません。");
	}
	await mkdir(resourceDirectory, { recursive: true });
	await rm(legacyStagedNativeHostPath, { force: true });
	await copyFile(source, stagedNativeHostPath);
	const stagedStat = await stat(stagedNativeHostPath);
	if (stagedStat.size !== sourceStat.size) {
		throw new Error("native-host.exeをTauriリソースへ正しく配置できませんでした。");
	}
	console.log(`同梱用native-hostを配置しました: ${stagedNativeHostPath}`);
	return stagedNativeHostPath;
}

if (import.meta.main) {
	try {
		await prepareNativeHost(process.argv.includes("--release"));
	} catch (error) {
		console.error(error instanceof Error ? error.message : "native-hostの準備に失敗しました。");
		process.exit(1);
	}
}
