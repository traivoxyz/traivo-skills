# Examples

`agent-loop.ts` shows how any agent can use these skills without a vendor SDK:

1. **Index up front.** The system prompt lists each skill's `name` and `description` only (`skillIndex()`), so the
   prompt stays small however many skills exist.
2. **Load on demand.** The model calls `load_skill` with a name; the loop returns that `SKILL.md` body.
3. **Allow-listed helpers.** The model calls `run_helper` with one of the read-only functions in `HELPERS`.
   Nothing that signs or sends a transaction is reachable.
4. **Answer.** The loop ends when the model replies without tool calls.

```bash
pnpm example                                   # offline, deterministic scripted model
AGENT_BASE_URL=https://your-endpoint/v1 AGENT_MODEL=your-model AGENT_API_KEY=… pnpm example "Is a 3,000 USDC NVDA buy ok?"
```

`httpModel()` speaks the common chat-completions JSON shape with tool calls; point it at whatever endpoint your
agent uses. Keys come from your environment, never from this repo.

Agents with native skill support (a `skills/` folder they discover by reading `SKILL.md` frontmatter) can use the
`skills/` directory as is; the helper scripts are run from the repository root with `pnpm tsx …`.
