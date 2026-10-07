import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type SkillMeta = { name: string; description: string; [key: string]: string };
export type Skill = { meta: SkillMeta; body: string; dir: string; scripts: string[] };

export const MAX_DESCRIPTION = 1024;
export const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Parse the YAML frontmatter of a SKILL.md. Only flat `key: value` pairs are supported (that is all a skill needs);
 * values may be wrapped in single or double quotes. Throws when the frontmatter block is missing.
 */
export function parseSkillFile(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error("SKILL.md must start with a --- frontmatter block");
  const meta: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`Unsupported frontmatter line: ${line}`);
    let v = (kv[2] ?? "").trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else if (/: |\s#/.test(v) || /^[[{&*!|>%@`'"]/.test(v))
      throw new Error(`Frontmatter value of "${kv[1]}" must be quoted (contains YAML syntax): ${v.slice(0, 60)}`);
    meta[kv[1]!] = v;
  }
  return { meta, body: (m[2] ?? "").trim() };
}

/** Problems with a skill's frontmatter (empty array = valid). `folder` is the skill's directory name. */
export function validateMeta(meta: Record<string, string>, folder: string): string[] {
  const problems: string[] = [];
  if (!meta.name) problems.push("missing name");
  else {
    if (meta.name !== folder) problems.push(`name "${meta.name}" does not match folder "${folder}"`);
    if (!NAME_PATTERN.test(meta.name) || meta.name.length > 64)
      problems.push("name must be lowercase letters, digits and hyphens, at most 64 chars");
  }
  if (!meta.description) problems.push("missing description");
  else if (meta.description.length > MAX_DESCRIPTION)
    problems.push(`description is ${meta.description.length} chars (max ${MAX_DESCRIPTION})`);
  return problems;
}

/** Load every `skills/<name>/SKILL.md` under `root`. Throws on invalid frontmatter. */
export function loadSkills(root: string): Skill[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "SKILL.md")))
    .map((d) => {
      const dir = join(root, d.name);
      const { meta, body } = parseSkillFile(readFileSync(join(dir, "SKILL.md"), "utf8"));
      const problems = validateMeta(meta, d.name);
      if (problems.length) throw new Error(`${d.name}: ${problems.join("; ")}`);
      const scriptDir = join(dir, "scripts");
      const scripts = existsSync(scriptDir) ? readdirSync(scriptDir).filter((f) => f.endsWith(".ts")) : [];
      return { meta: meta as SkillMeta, body, dir, scripts };
    })
    .sort((a, b) => a.meta.name.localeCompare(b.meta.name));
}

/** The short index an agent sees up front: one line per skill (name + description). Bodies load on demand. */
export function skillIndex(skills: readonly Skill[]): string {
  return skills.map((s) => `- ${s.meta.name}: ${s.meta.description}`).join("\n");
}

const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "for",
  "in",
  "on",
  "is",
  "it",
  "my",
  "i",
  "me",
  "this",
  "that",
  "with",
  "use",
  "when",
  "what",
  "how",
  "should",
]);
const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));

/**
 * Naive keyword ranking of skills for a request, for agents that do not pick skills themselves.
 * Returns skills with at least one overlapping word, best first. A real agent should let the model choose.
 */
export function rankSkills(request: string, skills: readonly Skill[]): Skill[] {
  const q = new Set(words(request));
  return skills
    .map((s) => {
      const d = new Set(words(`${s.meta.name.replace(/-/g, " ")} ${s.meta.description}`));
      let score = 0;
      for (const w of q) if (d.has(w)) score++;
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.s.meta.name.localeCompare(b.s.meta.name))
    .map((x) => x.s);
}
