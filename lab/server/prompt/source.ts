import { existsSync } from "node:fs";
import { resolve } from "node:path";

const PROMPT_FACADE_PATH = "src/amphi_agent/_prompt.py";
const PROMPT_MODULE_GLOB = "src/amphi_agent/prompts/**/*.py";

export interface PromptSourceFingerprint {
  paths: string[];
  sha256: string;
}

export function promptPythonExecutable(repositoryRoot: string): string {
  const configured = process.env.PYTHON?.trim();
  if (configured) return configured;

  for (const relativePath of [".venv/bin/python", ".venv/Scripts/python.exe"]) {
    const candidate = resolve(repositoryRoot, relativePath);
    if (existsSync(candidate)) return candidate;
  }

  const systemPython = Bun.which("python3") ?? Bun.which("python");
  if (systemPython) return systemPython;
  throw new Error("Could not find Python. Set PYTHON or create the repository .venv.");
}

export async function promptSourceFingerprint(repositoryRoot: string): Promise<PromptSourceFingerprint> {
  const modules: string[] = [];
  const glob = new Bun.Glob(PROMPT_MODULE_GLOB);
  for await (const sourcePath of glob.scan({ cwd: repositoryRoot, onlyFiles: true })) {
    modules.push(sourcePath.replaceAll("\\", "/"));
  }
  const paths = [PROMPT_FACADE_PATH, ...modules.sort()];
  const hasher = new Bun.CryptoHasher("sha256");
  for (const sourcePath of paths) {
    hasher.update(sourcePath);
    hasher.update("\0");
    const source = await Bun.file(resolve(repositoryRoot, sourcePath)).text();
    hasher.update(source.replaceAll("\r\n", "\n").replaceAll("\r", "\n"));
    hasher.update("\0");
  }
  return { paths, sha256: hasher.digest("hex") };
}
