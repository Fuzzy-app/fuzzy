type CargoMetadata = {
	target_directory?: unknown;
};

export async function cargoTargetDirectory(repositoryDirectory: string): Promise<string> {
	const process = Bun.spawn(["cargo", "metadata", "--no-deps", "--format-version", "1"], {
		cwd: repositoryDirectory,
		stdout: "pipe",
		stderr: "inherit",
	});
	const output = await new Response(process.stdout).text();
	const exitCode = await process.exited;
	if (exitCode !== 0) {
		throw new Error(`Cargoの出力先を確認できませんでした（終了コード: ${exitCode}）。`);
	}
	const metadata = JSON.parse(output) as CargoMetadata;
	if (
		typeof metadata.target_directory !== "string" ||
		!isAbsolute(metadata.target_directory)
	) {
		throw new Error("Cargoの出力先が不正です。");
	}
	return metadata.target_directory;
}
import { isAbsolute } from "node:path";
