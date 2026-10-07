/**
 * Minimal, vendor-neutral agent loop that uses this repo's skills.
 *
 *  1. The system prompt carries only the skill INDEX (name + description per skill).
 *  2. The model asks for a skill with the `load_skill` tool; the loop returns that SKILL.md body.
 *  3. The model calls read-only helpers with `run_helper`; only the allow-listed functions below can run.
 *  4. The model answers. Nothing here can sign or send a transaction.
 *
 * Run offline with the scripted model:   pnpm example
 * Run against your own agent endpoint:   AGENT_BASE_URL=… AGENT_MODEL=… AGENT_API_KEY=… pnpm example "size a buy …"
 * (the endpoint must accept the common chat-completions JSON shape with tool calls).
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isMain } from "../src/cli.js";
import { loadSkills, skillIndex, type Skill } from "../src/skills.js";
import { buildPlan } from "../skills/position-sizing/scripts/size.js";
import { preTradeChecks, verdict } from "../skills/pre-trade-check/scripts/checks.js";
import { assessPremium, usSession } from "../skills/tokenized-stock-vs-share/scripts/premium.js";
import { gradeAt, makeCall } from "../skills/scorecard-honesty/scripts/call.js";
import { rugReview, rugVerdict } from "../skills/rug-guard-review/scripts/review.js";

export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
};
export type ToolCall = { id: string; name: string; args: Record<string, unknown> };
export type ModelTurn = { text?: string; toolCalls?: ToolCall[] };
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };
/** Your agent: given the conversation and tools, return text and/or tool calls. */
export type Model = (messages: readonly Message[], tools: readonly ToolSpec[]) => Promise<ModelTurn>;

/** Pure, read-only helpers the model may call. Network helpers can be added the same way. */
export const HELPERS: Record<string, (args: any) => unknown> = {
  "position-sizing.buildPlan": buildPlan,
  "pre-trade-check.preTradeChecks": ({ quote, options }) => {
    const checks = preTradeChecks(quote, options);
    return { verdict: verdict(checks), checks };
  },
  "tokenized-stock-vs-share.assessPremium": (a) => assessPremium({ ...a, session: a.session ?? usSession(new Date()) }),
  "scorecard-honesty.makeCall": makeCall,
  "scorecard-honesty.gradeAt": ({ call, price, t }) => gradeAt(call, price, t),
  "rug-guard-review.rugReview": ({ facts }) => {
    const checks = rugReview(facts);
    return { verdict: rugVerdict(checks), checks };
  },
};

export const TOOLS: ToolSpec[] = [
  {
    name: "load_skill",
    description: "Load the full instructions of one skill from the index before using it.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "run_helper",
    description: `Run a read-only helper. Available: ${Object.keys(HELPERS).join(", ")}.`,
    parameters: {
      type: "object",
      properties: { helper: { type: "string", enum: Object.keys(HELPERS) }, args: { type: "object" } },
      required: ["helper", "args"],
    },
  },
];

export function systemPrompt(skills: readonly Skill[]): string {
  return [
    "You are Traivo AI, a read-only trading copilot for Ethereum mainnet. You never sign or send transactions.",
    "Skills available (load one with load_skill before following it):",
    skillIndex(skills),
  ].join("\n");
}

function runTool(call: ToolCall, skills: readonly Skill[]): string {
  if (call.name === "load_skill") {
    const s = skills.find((k) => k.meta.name === call.args.name);
    return s ? s.body : `Unknown skill "${String(call.args.name)}".`;
  }
  if (call.name === "run_helper") {
    const fn = HELPERS[String(call.args.helper)];
    if (!fn) return `Unknown helper "${String(call.args.helper)}".`;
    try {
      return JSON.stringify(fn(call.args.args ?? {}));
    } catch (e) {
      return `Helper failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return `Unknown tool "${call.name}".`;
}

/** Run the loop until the model answers without tool calls (or `maxTurns` is reached). */
export async function runAgent(model: Model, request: string, skills: readonly Skill[], maxTurns = 8) {
  const messages: Message[] = [
    { role: "system", content: systemPrompt(skills) },
    { role: "user", content: request },
  ];
  const trace: string[] = [];
  for (let turn = 0; turn < maxTurns; turn++) {
    const out = await model(messages, TOOLS);
    messages.push({ role: "assistant", content: out.text ?? "", toolCalls: out.toolCalls });
    if (!out.toolCalls?.length) return { answer: out.text ?? "", trace, messages };
    for (const call of out.toolCalls) {
      trace.push(`${call.name}(${JSON.stringify(call.args)})`);
      messages.push({ role: "tool", toolCallId: call.id, content: runTool(call, skills) });
    }
  }
  return { answer: "Stopped: too many turns without an answer.", trace, messages };
}

/** Deterministic stand-in model: loads position-sizing, runs the helper, answers from its output. */
export const scriptedModel: Model = async (messages) => {
  const tools = messages.filter((m) => m.role === "tool");
  if (tools.length === 0) return { toolCalls: [{ id: "1", name: "load_skill", args: { name: "position-sizing" } }] };
  if (tools.length === 1)
    return {
      toolCalls: [
        {
          id: "2",
          name: "run_helper",
          args: {
            helper: "position-sizing.buildPlan",
            args: { side: "buy", entry: 100, stop: 97, target: 106, maxLoss: 50 },
          },
        },
      ],
    };
  const plan = JSON.parse(tools[1]!.content) as ReturnType<typeof buildPlan>;
  if (!plan.size.ok) return { text: `No size: ${plan.size.error}` };
  return {
    text:
      `Buy ${plan.size.sizeTokens.toFixed(2)} units (≈ $${plan.size.sizeUsd.toFixed(0)}) with a stop at $${plan.stop} ` +
      `and a target at $${plan.target}: the stop loses $${plan.size.lossAtStop.toFixed(0)}, the target is ${plan.r}R. ` +
      "Inputs: entry $100 (example), max loss $50. Run pre-trade-check at this size before signing. Not financial advice.",
  };
};

/** Adapter for any endpoint that speaks the common chat-completions JSON shape with tool calls. */
export function httpModel(baseURL: string, model: string, apiKey?: string): Model {
  return async (messages, tools) => {
    const res = await fetch(`${baseURL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model,
        messages: messages.map((m) =>
          m.role === "tool"
            ? { role: "tool", tool_call_id: m.toolCallId, content: m.content }
            : m.toolCalls?.length
              ? {
                  role: m.role,
                  content: m.content || null,
                  tool_calls: m.toolCalls.map((c) => ({
                    id: c.id,
                    type: "function",
                    function: { name: c.name, arguments: JSON.stringify(c.args) },
                  })),
                }
              : { role: m.role, content: m.content },
        ),
        tools: tools.map((t) => ({ type: "function", function: t })),
      }),
    });
    if (!res.ok) throw new Error(`agent endpoint returned ${res.status}`);
    const data = (await res.json()) as {
      choices?: {
        message?: {
          content?: string | null;
          tool_calls?: { id: string; function: { name: string; arguments: string } }[];
        };
      }[];
    };
    const msg = data.choices?.[0]?.message;
    return {
      text: msg?.content ?? undefined,
      toolCalls: msg?.tool_calls?.map((c) => ({
        id: c.id,
        name: c.function.name,
        args: JSON.parse(c.function.arguments || "{}"),
      })),
    };
  };
}

if (isMain(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
  const skills = loadSkills(root);
  const request = process.argv.slice(2).join(" ") || "Size a buy at $100 with a 3% stop and a 6% target, max loss $50.";
  const { AGENT_BASE_URL, AGENT_MODEL, AGENT_API_KEY } = process.env;
  const model = AGENT_BASE_URL && AGENT_MODEL ? httpModel(AGENT_BASE_URL, AGENT_MODEL, AGENT_API_KEY) : scriptedModel;
  const { answer, trace } = await runAgent(model, request, skills);
  console.log(trace.map((t) => `→ ${t}`).join("\n"));
  console.log(`\n${answer}`);
}
