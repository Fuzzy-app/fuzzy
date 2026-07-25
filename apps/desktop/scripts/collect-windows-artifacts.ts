import { createHash } from "node:crypto";
import {
	copyFile,
	cp,
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { cargoTargetDirectory } from "./cargo-target";
import { validateDistributionVersions } from "./distribution-version";

const desktopDirectory = resolve(import.meta.dir, "..");
const repositoryDirectory = resolve(desktopDirectory, "..", "..");
const extensionOutputDirectory = resolve(repositoryDirectory, "apps", "extension", ".output");

async function filesRecursively(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await filesRecursively(path)));
		} else if (entry.isFile()) {
			files.push(path);
		}
	}
	return files;
}

async function singleMatchingFile(
	directory: string,
	matches: (file: string) => boolean,
): Promise<string> {
	const files = (await filesRecursively(directory)).filter(matches);
	if (files.length !== 1) {
		throw new Error(
			`配布成果物を1つに特定できません（${files.length}件）: ${directory}`,
		);
	}
	return files[0] as string;
}

async function sha256(file: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(file))
		.digest("hex");
}

async function assertNotOlder(
	generatedFile: string,
	sourceFile: string,
	description: string,
): Promise<void> {
	const [generated, source] = await Promise.all([stat(generatedFile), stat(sourceFile)]);
	if (generated.mtimeMs < source.mtimeMs) {
		throw new Error(`${description}が現在のビルド成果物より古いため、配布を中止しました。`);
	}
}

function assertPathWithin(root: string, target: string, description: string): void {
	const relativePath = relative(root, target);
	const firstSegment = relativePath.split(/[\\/]/, 1)[0];
	if (!relativePath || isAbsolute(relativePath) || firstSegment === "..") {
		throw new Error(`${description}が許可されたフォルダー配下ではありません。`);
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

async function publishStagedDirectory(
	distributionRoot: string,
	stagingDirectory: string,
	outputDirectory: string,
): Promise<void> {
	const nonce = `${process.pid}-${Date.now()}`;
	const previousDirectory = resolve(distributionRoot, `.fuzzy-previous-${nonce}`);
	assertPathWithin(distributionRoot, previousDirectory, "前回成果物の一時保全先");
	let previousExists = false;
	if (await pathExists(outputDirectory)) {
		await rename(outputDirectory, previousDirectory);
		previousExists = true;
	}
	try {
		await rename(stagingDirectory, outputDirectory);
	} catch (error) {
		if (previousExists) {
			await rename(previousDirectory, outputDirectory);
		}
		throw error;
	}
	if (previousExists) {
		try {
			await rm(previousDirectory, { recursive: true, force: true });
		} catch (error) {
			console.warn(`前回の配布成果物を削除できませんでした: ${String(error)}`);
		}
	}
}

export async function collectWindowsArtifacts(): Promise<string> {
	const distributionVersion = await validateDistributionVersions();
	const distributionRoot = resolve(repositoryDirectory, "dist");
	const outputDirectory = resolve(
		distributionRoot,
		`Fuzzy-${distributionVersion}-windows`,
	);
	assertPathWithin(distributionRoot, outputDirectory, "Windows配布成果物の出力先");
	const targetDirectory = resolve(
		await cargoTargetDirectory(repositoryDirectory),
		"release",
	);

	const installer = await singleMatchingFile(resolve(targetDirectory, "bundle", "nsis"), (file) =>
		new RegExp(
			`Fuzzy_${distributionVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_.+-setup\\.exe$`,
			"i",
		).test(basename(file)),
	);
	const desktopExecutable = resolve(targetDirectory, "Fuzzy.exe");
	if (!(await Bun.file(desktopExecutable).exists())) {
		throw new Error("Fuzzyデスクトップ実行ファイルが見つかりません。");
	}
	const nativeHost = resolve(desktopDirectory, "src-tauri", "resources", "FuzzyNativeHost.exe");
	if (!(await Bun.file(nativeHost).exists())) {
		throw new Error("同梱FuzzyNativeHost.exeが見つかりません。");
	}
	const extensionDirectory = resolve(extensionOutputDirectory, "chrome-mv3");
	if (!(await Bun.file(resolve(extensionDirectory, "manifest.json")).exists())) {
		throw new Error("同梱拡張機能が見つかりません。");
	}
	const extensionZip = await singleMatchingFile(extensionOutputDirectory, (file) =>
		basename(file)
			.toLowerCase()
			.endsWith(`-${distributionVersion.toLowerCase()}-chrome.zip`),
	);
	await assertNotOlder(installer, desktopExecutable, "NSISインストーラー");
	await assertNotOlder(installer, nativeHost, "NSISインストーラー");
	for (const bundledExtensionFile of await filesRecursively(extensionDirectory)) {
		await assertNotOlder(installer, bundledExtensionFile, "NSISインストーラー");
	}
	await assertNotOlder(
		extensionZip,
		resolve(extensionDirectory, "manifest.json"),
		"拡張機能ZIP",
	);

	const nonce = `${process.pid}-${Date.now()}`;
	const stagingDirectory = resolve(distributionRoot, `.fuzzy-staging-${nonce}`);
	assertPathWithin(distributionRoot, stagingDirectory, "配布成果物の一時作成先");
	const qaDirectory = resolve(stagingDirectory, "QA-確認用");
	const portableDirectory = resolve(qaDirectory, "Fuzzy-Portable");
	const portableResourceDirectory = resolve(portableDirectory, "resources");
	await mkdir(portableResourceDirectory, { recursive: true });
	let published = false;
	try {
		await copyFile(installer, resolve(stagingDirectory, "Fuzzy-Setup.exe"));
		await copyFile(desktopExecutable, resolve(portableDirectory, "Fuzzy.exe"));
		await copyFile(nativeHost, resolve(portableResourceDirectory, "FuzzyNativeHost.exe"));
		await copyFile(nativeHost, resolve(qaDirectory, "FuzzyNativeHost.exe"));
		await cp(extensionDirectory, resolve(portableResourceDirectory, "extension", "chrome-mv3"), {
			recursive: true,
		});
		await copyFile(extensionZip, resolve(qaDirectory, "Fuzzy-Extension.zip"));

		const readme = `Fuzzy ${distributionVersion} Windows テスト配布

【推奨】Fuzzy-Setup.exe をダブルクリックしてインストールしてください。
native-hostの配置・ブラウザ登録・アンインストール時の解除はインストーラーが自動で行います。コマンド操作は不要です。

初回起動後は画面の案内に従って保存先とルールを選んでください。この公開審査前テスト版だけは、「同梱フォルダーを表示」を押し、ブラウザの拡張機能管理画面でデベロッパーモードを有効にして「パッケージ化されていない拡張機能を読み込む」から表示されたchrome-mv3フォルダーを選びます。ビルドやターミナルは不要です。正式公開版は公式ブラウザストアから追加し、デベロッパーモードを使用しません。
初期設定時に既存資料をその場で登録しますが、資料ファイル自体は移動・削除しません。セットアップ後の画面では、保存先の再スキャン・検索索引再構築とバックアップの書き出し・復元もボタンとOSダイアログだけで行えます。
SQLiteまたは検索索引を開けない場合も起動時に復旧画面を表示します。バックアップ復元、破損DBを別名保全した後の新規作成、検索索引再構築を画面だけで実行できます。

「QA-確認用」フォルダーは開発・審査用です。Fuzzy-Portableはインストーラーを使わない実機確認用で、Fuzzy.exeをダブルクリックするとnative-host登録を自動実行します。通常利用とアンインストール確認にはFuzzy-Setup.exeを使用してください。
Fuzzy-Extension.zipとFuzzyNativeHost.exeは拡張機能ストア提出・内部結合確認用です。一般利用者は開いたり、展開したり、コマンド操作したりする必要はありません。

このテスト成果物はコード署名証明書が未設定のため未署名です。一般公開版ではWindowsコード署名を行ってから配布してください。
現在の配布版は利用データをローカルSQLiteへ保存し、外部へ送信しません。
`;
		await writeFile(resolve(stagingDirectory, "README.txt"), readme, "utf8");

		const checksumTargets = (await filesRecursively(stagingDirectory)).filter(
			(file) => basename(file) !== "SHA256SUMS.txt",
		);
		checksumTargets.sort();
		const checksumLines = await Promise.all(
			checksumTargets.map(async (file) => {
				const relativePath = relative(stagingDirectory, file).replaceAll("\\", "/");
				return `${await sha256(file)}  ${relativePath}`;
			}),
		);
		await writeFile(
			resolve(stagingDirectory, "SHA256SUMS.txt"),
			`${checksumLines.join("\n")}\n`,
			"utf8",
		);
		await publishStagedDirectory(distributionRoot, stagingDirectory, outputDirectory);
		published = true;
	} finally {
		if (!published && (await pathExists(stagingDirectory))) {
			await rm(stagingDirectory, { recursive: true, force: true });
		}
	}
	console.log(`Windows配布成果物を集約しました: ${outputDirectory}`);
	return outputDirectory;
}

if (import.meta.main) {
	try {
		await collectWindowsArtifacts();
	} catch (error) {
		console.error(error instanceof Error ? error.message : "Windows成果物の集約に失敗しました。");
		process.exit(1);
	}
}
