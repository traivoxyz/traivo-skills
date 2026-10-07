import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_DESCRIPTION, loadSkills, parseSkillFile, rankSkills, skillIndex, validateMeta } from "../src/skills.js";

const ROOT = join(import.meta.dirname, "..", "skills");
const folders = readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const EXPECTED = [
  "explain-this-move",
  "position-sizing",
  "pre-trade-check",
  "rug-guard-review",
  "scorecard-honesty",
  "tokenized-stock-vs-share",
];

describe("every SKILL.md", () => {
  it("ships the v0.1 skill set", () => {
    expect(folders.sort()).toEqual(EXPECTED);
  });

  for (const folder of folders) {
    describe(folder, () => {
      const file = join(ROOT, folder, "SKILL.md");
      it("has a SKILL.md", () => expect(existsSync(file)).toBe(true));
      const { meta, body } = parseSkillFile(readFileSync(file, "utf8"));
      it("has valid frontmatter (name matches folder, description ≤ 1024 chars)", () => {
        expect(validateMeta(meta, folder)).toEqual([]);
        expect(meta.name).toBe(folder);
        expect(meta.description!.length).toBeGreaterThan(40);
        expect(meta.description!.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
      });
      it("documents failure modes and has a body", () => {
        expect(body.length).toBeGreaterThan(200);
        expect(body).toMatch(/## Failure modes/);
      });
      it("references only scripts that exist", () => {
        for (const m of body.matchAll(/skills\/([a-z-]+)\/scripts\/([a-z-]+\.ts)/g))
          expect(existsSync(join(ROOT, m[1]!, "scripts", m[2]!)), m[0]).toBe(true);
      });
    });
  }
});

describe("parseSkillFile / validateMeta", () => {
  it("parses quoted values and ignores comments", () => {
    const { meta, body } = parseSkillFile(`---\nname: "a-b"\n# note\ndescription: 'Does x: y'\n---\n\n# Body\n`);
    expect(meta).toEqual({ name: "a-b", description: "Does x: y" });
    expect(body).toBe("# Body");
  });
  it("rejects a file without frontmatter", () => {
    expect(() => parseSkillFile("# no frontmatter")).toThrow(/frontmatter/);
  });
  it("rejects unquoted values that strict YAML parsers would reject", () => {
    expect(() => parseSkillFile("---\nname: x\ndescription: does a: b\n---\n")).toThrow(/must be quoted/);
    expect(() => parseSkillFile("---\nname: x\ndescription: [list]\n---\n")).toThrow(/must be quoted/);
    expect(parseSkillFile('---\nname: x\ndescription: "does a: b"\n---\n').meta.description).toBe("does a: b");
  });
  it("rejects nested YAML", () => {
    expect(() => parseSkillFile("---\nname: x\n  - nested\n---\n")).toThrow(/Unsupported/);
  });
  it("reports every problem", () => {
    expect(validateMeta({}, "x")).toEqual(["missing name", "missing description"]);
    expect(validateMeta({ name: "Bad_Name", description: "d" }, "Bad_Name")).toEqual([
      "name must be lowercase letters, digits and hyphens, at most 64 chars",
    ]);
    expect(validateMeta({ name: "a", description: "d" }, "b")[0]).toMatch(/does not match folder/);
    expect(validateMeta({ name: "a", description: "x".repeat(1025) }, "a")[0]).toMatch(/1025 chars/);
  });
});

describe("loadSkills / skillIndex / rankSkills", () => {
  const skills = loadSkills(ROOT);
  it("loads all skills sorted, with their scripts", () => {
    expect(skills.map((s) => s.meta.name)).toEqual(EXPECTED);
    expect(skills.find((s) => s.meta.name === "position-sizing")!.scripts).toEqual(["size.ts"]);
  });
  it("builds a one-line-per-skill index", () => {
    expect(skillIndex(skills).split("\n")).toHaveLength(EXPECTED.length);
  });
  it("ranks skills by keyword overlap", () => {
    expect(rankSkills("how big should my position size be with a stop", skills)[0]!.meta.name).toBe("position-sizing");
    expect(rankSkills("is this token a rug", skills)[0]!.meta.name).toBe("rug-guard-review");
    expect(rankSkills("why did the price move today", skills)[0]!.meta.name).toBe("explain-this-move");
    expect(rankSkills("is the NVDA tokenized stock cheap vs the listed share", skills)[0]!.meta.name).toBe(
      "tokenized-stock-vs-share",
    );
    expect(rankSkills("zzzz", skills)).toEqual([]);
  });
});
