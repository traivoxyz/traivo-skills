import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HELPERS, TOOLS, runAgent, scriptedModel, systemPrompt, type Model } from "../examples/agent-loop.js";
import { loadSkills } from "../src/skills.js";

const skills = loadSkills(join(import.meta.dirname, "..", "skills"));

describe("example agent loop", () => {
  it("loads a skill on demand, runs a helper, answers", async () => {
    const { answer, trace } = await runAgent(scriptedModel, "size it", skills);
    expect(trace[0]).toMatch(/^load_skill/);
    expect(trace[1]).toMatch(/^run_helper/);
    expect(answer).toMatch(/16\.67 units/);
    expect(answer).toMatch(/2R/);
  });
  it("puts only the index in the system prompt", () => {
    const p = systemPrompt(skills);
    for (const s of skills) expect(p).toContain(`- ${s.meta.name}: `);
    expect(p).not.toContain("## Failure modes");
  });
  it("exposes only read-only helpers", () => {
    for (const name of Object.keys(HELPERS)) expect(name).not.toMatch(/send|sign|execute|write/i);
    expect(TOOLS.map((t) => t.name)).toEqual(["load_skill", "run_helper"]);
  });
  it("reports unknown skills, helpers and tools back to the model", async () => {
    const seen: string[] = [];
    let step = 0;
    const model: Model = async (messages) => {
      const last = messages[messages.length - 1]!;
      if (last.role === "tool") seen.push(last.content);
      step++;
      if (step === 1) return { toolCalls: [{ id: "a", name: "load_skill", args: { name: "nope" } }] };
      if (step === 2)
        return { toolCalls: [{ id: "b", name: "run_helper", args: { helper: "wallet.send", args: {} } }] };
      if (step === 3) return { toolCalls: [{ id: "c", name: "sign_tx", args: {} }] };
      if (step === 4)
        return {
          toolCalls: [{ id: "d", name: "run_helper", args: { helper: "scorecard-honesty.makeCall", args: {} } }],
        };
      return { text: "done" };
    };
    const { answer } = await runAgent(model, "x", skills);
    expect(answer).toBe("done");
    expect(seen[0]).toMatch(/Unknown skill/);
    expect(seen[1]).toMatch(/Unknown helper/);
    expect(seen[2]).toMatch(/Unknown tool/);
    expect(seen[3]).toMatch(/Helper failed: Missing symbol/);
  });
  it("stops after max turns", async () => {
    const loop: Model = async () => ({
      toolCalls: [{ id: "x", name: "load_skill", args: { name: "position-sizing" } }],
    });
    expect((await runAgent(loop, "x", skills, 2)).answer).toMatch(/too many turns/);
  });
});
