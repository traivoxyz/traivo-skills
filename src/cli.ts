import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** True when the module at `metaUrl` is the process entry point (so helpers stay importable without side effects). */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

export type Flags = Record<string, string | true>;

/** Minimal `--key value` / `--flag` parser. */
export function parseFlags(argv: readonly string[]): Flags {
  const out: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a?.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 2) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}

export function num(flags: Flags, key: string): number | undefined {
  const v = flags[key];
  if (v === undefined || v === true) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${key} must be a number, got "${v}"`);
  return n;
}

export function str(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

/** Print JSON to stdout; errors go to stderr with exit code 1. */
export async function runCli(main: () => Promise<unknown> | unknown): Promise<void> {
  try {
    const result = await main();
    process.stdout.write(JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}
