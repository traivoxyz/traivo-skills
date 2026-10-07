import { existsSync, readdirSync } from "node:fs";
import { defineConfig } from "tsup";

// Every skill helper script is also a runnable CLI from dist/. Scripts are bundled without code splitting so that
// each file keeps its own `import.meta.url` (the CLI guard compares it with the process entry point).
const scripts: Record<string, string> = {};
for (const skill of readdirSync("skills")) {
  const dir = `skills/${skill}/scripts`;
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir))
    if (file.endsWith(".ts")) scripts[`skills/${skill}/${file.replace(/\.ts$/, "")}`] = `${dir}/${file}`;
}

const shared = { format: ["esm" as const], dts: true, sourcemap: true, target: "es2022", external: ["viem"] };

export default defineConfig([
  { ...shared, entry: { index: "src/index.ts" } },
  { ...shared, entry: scripts, splitting: false },
]);
