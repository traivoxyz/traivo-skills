/**
 * Shape and lint an "explain this move" answer. The agent writes the words; these helpers make sure the answer
 * leads with the conclusion, attributes every claim to a source, and says what is unknown.
 */

export type SourceKind = "onchain" | "wallet" | "news" | "reference";
export type Claim = { text: string; kind: SourceKind; source: string };
export type ExplainInput = {
  symbol: string;
  /** One or two sentences: the most likely explanation, or "no clear cause" when evidence is thin. */
  lead: string;
  /** e.g. "blocks 1,234,000–1,239,000" or "last 24h". */
  window: string;
  claims: Claim[];
  unknowns: string[];
};

const HEADINGS: Record<SourceKind, string> = {
  onchain: "On-chain flows",
  wallet: "Large wallets",
  news: "News",
  reference: "Reference prices",
};

/** Problems that make the input unfit to publish (empty = fine). */
export function explainProblems(i: ExplainInput): string[] {
  const p: string[] = [];
  if (!i.lead.trim()) p.push("Lead with the answer.");
  if (sentenceCount(i.lead) > 2) p.push("Lead must be one or two sentences.");
  if (!i.window.trim()) p.push("State the time or block window the evidence covers.");
  if (!i.claims.length) p.push("No evidence: say there is no clear cause instead of guessing.");
  i.claims.forEach((c, k) => {
    if (!c.source.trim()) p.push(`Claim ${k + 1} has no source.`);
  });
  if (!i.unknowns.length) p.push("List at least one thing that is unknown (there always is one).");
  return [...p, ...promiseProblems([i.lead, ...i.claims.map((c) => c.text)].join(" "))];
}

/** Render the canonical answer layout as Markdown. Throws when explainProblems() is not empty. */
export function composeExplanation(i: ExplainInput): string {
  const problems = explainProblems(i);
  if (problems.length) throw new Error(problems.join(" "));
  const out = [i.lead.trim(), "", `Window: ${i.window}.`];
  for (const kind of Object.keys(HEADINGS) as SourceKind[]) {
    const rows = i.claims.filter((c) => c.kind === kind);
    if (!rows.length) continue;
    out.push("", `**${HEADINGS[kind]}**`, ...rows.map((c) => `- ${c.text} (source: ${c.source})`));
  }
  out.push("", "**What is not known**", ...i.unknowns.map((u) => `- ${u}`), "", "Not financial advice.");
  return out.join("\n");
}

const PROMISES = [
  /\bguarantee(d|s)?\b/i,
  /\brisk[- ]free\b/i,
  /\bwill (definitely|certainly|surely)\b/i,
  /\b(can't|cannot|won't) (lose|go down)\b/i,
  /\bsure (thing|bet)\b/i,
  /\bto the moon\b/i,
];

/** Phrases that promise returns or certainty. */
export function promiseProblems(text: string): string[] {
  return PROMISES.filter((r) => r.test(text)).map((r) => `Remove promise/certainty wording matching ${r.source}.`);
}

export function sentenceCount(text: string): number {
  return text
    .replace(/\b(e\.g|i\.e|vs|approx|U\.S)\./gi, "$1")
    .replace(/\d\.\d/g, "0")
    .split(/[.!?]+(\s|$)/)
    .filter((s) => s && s.trim().length > 0).length;
}
