# pi-lazy-compact

One design — **lazy compaction** — in two layers:

1. **An installable pi extension** (`extensions/`) that implements the whole
   design against the real extension API — hot postfix summary with the
   `compact_ack` contract, retry ladder and legacy fallback, archive +
   `history_pull` lazy prefill, pinned protocol-tool template.
2. **Prefix-cache proofs** against a fake pi infra (`test/`). No real LLM is
   called in the tests: the "provider" is a prefix-cache oracle that
   measures, per request, how much of the prompt is a cache read vs a fresh
   prefill. The only thing under test there is the shape of the request
   sequence: "does request N+1 start with request N?"

Three parts, one invariant — *every new request starts with the last one*,
except at batched rewrite boundaries:

| Part | File | Idea |
|---|---|---|
| **A. hot summary** | `test/part-a-hot-summary.test.ts` | generate the compaction summary as a side-channel request that strictly extends the last live request (same model, system, tools, messages + one appended "call `compact_ack`" instruction) instead of pi's fresh separate-prompt call |
| **B. archive + on-demand pull** | `test/part-b-archive-pull.test.ts` | the summary is a two-tier document — head-ups (always in-context) + an Archive of addressable skim lines; the agent pulls an entry's raw detail on demand via `history_pull`; the chunk lands at the TAIL as a tool result; consumed lines are dropped only at the next compaction |
| **C. pinned tool template** | `test/part-c-tool-template.test.ts` | both protocol tools are bundled into the tool template at session start; the template never changes, so the only prefix breaks in the session are compaction rebuilds |
| **D. ack ladder logic** | `test/part-d-ladder.test.ts` | the protocol decision logic itself (what counts as compliance, retry messages, archive/doc construction) — pure, tested without pi |

The real extension (`extensions/lazy-compact.ts` + `lazy-compact-core.ts`)
implements the same three parts on the actual pi API — see below.

One-liner: **pin the form, stream the data, page the detail.**

## 0.3.0 — the redesign: compaction IS the context spill

> **Read this first (0.3.0, user-directed).** The LLM-summary design below
> (Part A, v0.2.x) is **retired**. Compaction no longer asks the model for
> anything. The sections further down document the 0.2.x path, which is
> recoverable from the v0.2.9 tarball if ever wanted.

pi's default compaction (an LLM summarization call + a rebuild) is
**inferior and strictly deprecated** by this extension: it costs full
prefills, can 400 at the context ceiling, and its quality depends on model
compliance. 0.3.0 replaces it with a deterministic **context spill**:

- **SPILL (the compaction itself)** — when pi fires `session_before_compact`,
  the hook *immediately* returns a spill document in place of the old region.
  **Zero LLM calls, zero prefills, instant, cannot 400.** The doc contains:
  - *Head-ups*: the flattened condensed history (0.3.1 — never the whole
    previous doc; older regions fold into compact *Past regions* lines)
  - *Region digest*: deterministic file ops of the spilled region
    (read / modified — from pi's own `preparation.fileOps`)
  - *Archive*: entry-ID spans covering the spilled region
  - *Re-read channels*, listed in the doc: `history_pull` spans → the spill
    dump file → the raw session file
- **DUMP** — the full session context is written to
  `~/.pi/agent/lazy-compact/dumps/<sessionId>-<ts>.md` on every spill: the
  definitive re-read source and a seed for a fresh session if ever wanted.
- **RE-READ (on demand, and on failure)** — the agent re-reads spilled
  detail instead of remembering it: `history_pull(from, to?)` (tail-appended
  tool result → next turn is a cache read + the pulled chunk), the dump
  file, or the session file. Pull errors point at the dump/session file.
- **STRICT DEPRECATION, monitored** — the hook always produces the
  compaction (or a clean cancel on abort/error), so the default path never
  runs; a `session_compact` listener alarms loudly if a legacy
  (`fromExtension: false`) compaction ever lands.
- **Retired in 0.3.0**: the hot/cold LLM summarization path, the
  `compact_ack` protocol tool, and live-call snapshot capture.
  `history_pull` remains the single pinned protocol tool.

The mental model, unchanged: **only the template is pinned in the prefix —
the form is pinned, the data streams, the detail is paged.**

### 0.3.1 patch — the spill doc no longer nests

0.3.0 embedded the previous compaction doc **verbatim** under Head-ups. Each
spill therefore carried the whole previous doc, which carried the one before,
and so on: the doc grew without bound (and inherited whatever bloat the old
legacy LLM summaries had accumulated), so the post-compaction prefill shrank
only slowly and never settled. **"Grows slowly and never shrinks" was this.**

`buildSpillDoc` now **flattens** the previous doc (deterministic parser,
`parseSpillDoc`): the innermost head-ups are kept, every older region folds
into one compact *Past regions* line (`- ~146563 tokens spilled: e1→e9,
e10→e14` — spans stay pullable), and the Archive carries only the current
region. Doc size is bounded: constant head-ups + one small line per spill.
Legacy LLM summaries are carried verbatim as the head-ups (bounded by the
model's own output) and become the root of the flattened chain — existing
sessions migrate on their next spill.

Also new: `node scripts/spill-anatomy.mjs <session.jsonl>` — prints per
compaction the doc size + nesting depth, kept-tail size, biggest tail
messages, and the next turn's usage, so the post-compaction prefill can be
accounted for (system+tools + doc + tail, all fresh to the server after the
prefix shape changes). The other lever is pi's `compaction.keepRecentTokens`
(default 20000) — the kept tail is the prefill floor; the spill makes
smaller tails safe because detail is pullable.

---

## Background: why pi's compaction costs two full prefills

Prefix caches are keyed on the exact token prefix. Today's pi compaction:

1. **Summary call** — a fresh prompt (separate summarization system prompt +
   serialized span, `cacheRetention: "none"`) → zero cache reuse, full
   prefill, no cache write.
2. **First post-compaction turn** — context rebuilt as
   `[system, summary, kept-tail]`; the kept tail no longer follows the same
   prefix as before → its cache is dead too → full prefill of the rebuild.

Lazy compaction attacks both: A makes the summary call a cache read; B makes
the discarded detail recoverable at bounded on-demand cost; C keeps the tool
surface from adding a third invalidation axis.

## Part A — hot summary

Proven:

- legacy shape: `cacheRead = 0`, full prefill of the span, and (with
  `cacheRetention: "none"`) a repeat costs it again;
- hot shape: the request **strictly starts with** the last live request →
  the entire live context is a cache read; the fresh prefill is *only* the
  appended instruction (< 2% of the context);
- the side channel never leaks: the instruction is not persisted as a
  session message and never appears in the rebuilt context;
- prefill 2 (the post-compaction rebuild) remains — unavoidable for any
  middle-deletion — but it is the *small* post-compaction context.

The `compact_ack` tool call is the response contract: success is
`stopReason: toolUse && name === "compact_ack"`, so a model that ignores the
instruction and continues the task produces a **detectable protocol
violation** (retry cache-warm, then fall back to the legacy separate-prompt
call) instead of a silently corrupted summary.

## Part B — archive + on-demand pull

The document:

```
## Head-ups                      <- always in-context
- Decision: retry uses exponential backoff ...
- Open: flaky test in scheduler.spec.ts

## Archive (pull up with history_pull)   <- one line per pull-up-able unit
- [A1] entries e2-e5: explored 3 approaches; rejected A (perf), B (deps)
- [A2] entries e6-e9: retry loop implementation; final state all green
```

Design rule: **between compactions the prompt is append-only** — including
the document. A consumed archive line is NOT dropped at pull-up time; the
drop is batched into the next compaction, which rewrites the document
anyway. Proven:

- pull-up turns are strict prefix extensions — cache stays warm, and the
  pull-up request's fresh prefill is **exactly** the pulled chunk (+ the tool
  call): the "lazy prefill" pays only for what it pulls;
- counter-example: dropping the pulled line immediately rewrites the prompt
  at slot 1 → not a prefix extension → full re-prefill *including the chunk
  that was just paid for*;
- the next compaction batches the rewrite (one full prefill of the small
  context): consumed line dropped, un-consumed line carried forward, pulled
  essence absorbed into head-ups; the append-only chain resumes.

## Part C — pinned tool template

Real providers serialize `tools` **before** the messages — the tool list is
inside the cache key; pi additionally rebuilds the system prompt with the
tool names, so a tool change touches TWO prefix elements. Lazy compaction
bundles both protocol tools into the template at session start:

```
template = [steady-state tools, compact_ack, history_pull]   // never changes
```

Both are extension-registered (no MCP server race), tiny, and
protocol-critical — ~100 tokens/turn from turn 0 buys the strongest
invariant. Proven:

- **C1 bundled**: live turns, the hot summary request, the post-compact
  rebuild and all pulls carry byte-identical tool lists; the *only* non
  prefix-extension in the whole session is the compaction rebuild;
- **C2 general law**: adding/changing any tool mid-session busts the cache
  like a mid-prompt edit (`cacheRead = 0` in the sim);
- **C3 the `compact_ack` trap**: injecting the ack tool only into the
  summary request diverges at the tool list → the entire hot prefix is lost.
  (Deferring it to a rebuild boundary is cache-free but costs the first hot
  summary of the session — bundling from turn 0 is simpler and strictly
  better.)

The entry TABLE never goes in the schema: `history_pull(from: entryId,
to?)` is a stable pipe taking any entry-ID span; the table of valid entries
lives in the Archive section (it must be there anyway — the skims make pulls
targetable), and stale/unknown IDs are rejected client-side with a
self-correcting tool-result error.

## How this sits on pi's tool/MCP expansion policy

Findings from the installed pi (`docs/mcp.md`, `docs/cli.md`,
`dist/core/agent-session.js`, `dist/extensions/tool-search/`):

- **Exposure tiers**: MCP tools default to `codemode` — *never declared to
  the model* (reachable only via codemode scripts), so a fleet of MCP servers
  costs zero prompt tokens and can't bust the prefix. `direct` = declared
  like built-ins; `deferred` = declared only after discovery; `hidden` =
  unreachable.
- **`tool_search` (off by default)** is pi's own lazy-tool mechanism: a BM25
  search over undeclared tools whose matches "are declared for the next model
  call". Loaded tools are **sticky per branch** — "recorded in the session
  like other tool changes, so they stay declared on that branch" and survive
  `/tree`, resume, fork. So each discovery costs ONE intentional re-prefill,
  then the list is stable.
- **pi is explicitly cache-aware about the tool list**: "tools that stay
  active keep their current order and newly active ones are appended, so
  reordering the same names does not change the prompt (#11495)". Server
  tool-list changes follow the same append-only discipline ("new tools are
  added").
- **Startup race**: servers connect in the background at session start; the
  first prompt waits up to 10 s for `direct`-tool servers only. A `direct`
  server that connects later grows the list → one intentional re-prefill.

Consequence for lazy compaction: the invariant is really **one prefix
lineage per tool-list generation**. Pi's own expansion events (tool_search
load, direct server connect, `/mcp` toggle, `/reload`) start a new
generation with one paid re-prefill — same economics as a compaction
rebuild. Lazy compaction adds **no new generation events**: both protocol
tools exist from generation 0 and never change; every hot summary request
just extends whichever lineage is current.

## The fake infra (test/fake/)

| file | what it fakes |
|---|---|
| `session.ts` | pi's session: append-only entries + compaction-aware projection (newest compaction wins; context = `[summary] + messages from firstKeptEntryId`), mirroring `dist/core/session-manager.js` |
| `provider.ts` | the LLM + prefix cache. Prompts serialize to canonical strings (1 char ≈ 1 token); `tools` serialize between system and messages — inside the cache key, like real providers; `cacheRead` = longest cached prompt that is a string prefix of the request; `freshInput` = the rest; `cacheRetention: "none"` reads but writes nothing |
| `agent.ts` | scripted scenario: user task + N rounds of (assistant tool call → tool result) + final answer, on a pinned tool template |

Deliberately not modeled: cache TTL/expiry, sub-message cache breakpoints (a
real provider may credit a partial hit up to the last breakpoint before the
divergence — the oracle only credits whole-prompt prefixes, so measured
savings are **conservative**), pricing tiers, branches/tree, context_edit.

## Run

```bash
cd pi-ext && npm install
npm test                                  # from the root (all packages)
# or just this package:
cd packages/pi-lazy-compact && npm test   # node --test test/**/*.test.ts
```

## The real extension (implemented)

`extensions/lazy-compact.ts` wires the design to pi's actual extension API.
No pi core changes are needed — everything below exists in the public surface:

**Hot summary (part A)** — the crux is getting the *exact* live request
prefix from inside an extension:

- `context_with_system` fires before every live LLM call with the full
  transcript, and its leading system message carries the prompt **and the
  tool declarations** (`SystemMessage.toolsAdded`; verified in pi-ai
  `utils/transcript.js` and the extension `runner.js`). The extension
  snapshots that leading system message (deep clone + leaf id + model id) on
  every call. The conversation part needs no snapshot: it is rebuilt at
  compaction time from `sessionManager.buildSessionProjection()` — always
  current.
- `session_before_compact` then sends
  `modelRegistry.complete(model, { messages: [snapSystem, ...projection, instruction] })`.
  pi-ai's `normalizeContext` passes a pre-folded transcript through
  untouched, so the request is byte-identical to the live request plus the
  instruction — and it uses the **same `sessionId`** the live pipeline uses
  (`sdk.js` passes `sessionManager.getSessionId()`), so routing/cache state
  is shared.
- Guards before the hot path (each failure → legacy fallback, except cold
  start which degrades in cost, not in output):
  - **no in-memory snapshot** (pi restarted, `/reload`ed, or compaction
    before any LLM call in this process): try the **disk snapshot**
    (`~/.pi/agent/lazy-compact/<sessionId>.json`, written on every live
    call) — the llama.cpp server's KV cache outlives the pi process, so a
    restored snapshot (validated by the lineage scan) rides a still-warm
    prefix. If no disk snapshot either: **cold start** — synthesize the
    leading system message from `getSystemPrompt()` with only the
    `compact_ack` declaration. Full fresh prefill (legacy-equivalent cost),
    but the ack contract, retry ladder and two-tier doc still apply.
  - **abort** (escape during compaction): no retry on a dead signal, no
    misleading "non-compliance" — the handler returns `{cancel: true}` and
    pi reports the cancellation once.
  - **prefix-lineage drift** since the snapshot → legacy. The scan is over
    raw branch entries between the snapshot leaf and the current leaf: pure
    appends (messages, usage, labels, session info) keep the lineage intact
    — the leaf is *always* ahead of the snapshot in the common case, because
    the turn's final assistant message lands after the last request. Drift =
    `model_change`, `thinking_level_change`, `context_edit`, `compaction`,
    `branch_summary`, or `custom` entries (tool loads etc.), or the snapshot
    leaf missing from the branch (tree navigation).
  - no model → legacy.
- Ladder: attempt 1 → `extractAck` (dual contract: `compact_ack` tool call
  with summary ≥ 80 chars, **or** a `<compaction_summary> …
  </compaction_summary>` text block; a marker block clipped at
  `stopReason: "length"` is accepted, flagged truncated) → on failure one
  **cache-warm retry** (append the offending response + a forceful
  re-instruction — still a prefix extension of attempt 1; skipped with an
  explanation when the append would exceed the context window) → on failure
  **COLD RECOVERY** (0.2.8): one full-prefill attempt with the synthesized
  system message — still *our* protocol (ack contract, two-tier doc), never
  pi's legacy compaction → on failure **PANIC CONTEXT SPILL** (0.2.8,
  model-free, always succeeds): the previous compaction summary becomes the
  head-ups tier, the archive index records the spilled region (fully
  pullable via `history_pull`), and an explicit "NOT summarized — pull up
  before answering" warning is baked in. The session **continues** from the
  spill at reduced fidelity; a full dump is also written to
  `~/.pi/agent/lazy-compact/dumps/<sessionId>-<ts>.md` (seed a fresh session
  from it if you ever want a clean restart). Aborts (your escape) cancel
  cleanly without a dump. The session is never killed and never handed to
  pi's legacy compaction.
- The ack response is never persisted: it is parsed out of the side-channel
  call and thrown away; only the resulting two-tier document enters the
  session as the compaction entry's summary.

**Lazy prefill (part B)** — `history_pull(from, to?)` reads the raw branch
(`sessionManager.getBranch()` — summarized entries are still on disk),
serializes the span with pi's own `sessionEntryToContextMessages` +
`convertToLlm` + `serializeConversation`, caps at 12 000 chars. Unknown IDs
return a self-correcting error listing the current archive spans. The
document's Archive section lists the spans (real entry IDs, deterministic —
no model work), one per user-message span of the summarized region.

**Pinned template (part C)** — both tools are registered at extension load
via `registerTool` (hand-written JSON schemas, zero runtime dependencies
beyond pi itself) and never touched again. `compact_ack` gets no
`promptSnippet` (low salience in the system prompt); its description forbids
live-turn use, and its `execute` is a soft-refusal guardrail for the rare
rogue live call (the hot compaction call is parsed directly, never executed).

### Changelog (0.2.x — feature-frozen patches)
- **0.3.0** — **REDESIGN (user-directed, feature freeze lifted): compaction
  IS the context spill.** No LLM calls at compaction time, ever — the
  default compaction is strictly deprecated (and monitored via a
  `session_compact` alarm for `fromExtension:false` entries). The hook
  returns a deterministic spill doc (previous summary + region digest from
  `preparation.fileOps` + archive index + re-read channels) and writes the
  full context to `~/.pi/agent/lazy-compact/dumps/<sessionId>-<ts>.md` on
  every spill. Re-read is the designed recovery: `history_pull` spans, the
  dump file, or the raw session file. Retired: hot/cold LLM summarization,
  `compact_ack`, snapshot capture (recoverable in v0.2.9).
- **0.2.9** — **never-legacy hardening + self-diagnosing entries** (found
  while debugging a full-prefill report on another machine): pi's extension
  runner *silently swallows* errors thrown by a `session_before_compact`
  handler and degrades to legacy compaction (full prefill,
  `fromHook: false`). The whole handler body is now wrapped in a
  last-line-of-defense try/catch that degrades to the model-free panic
  spill instead — a thrown error can no longer produce a legacy full
  prefill. Every compaction entry now persists `details.lazyCompact`
  (`tier: "hot" | "cold-start" | "cold-recovery" | "spill"`, `note`,
  `promptTokens`, and on spill the `error`/`dump`), so the session file
  itself tells you exactly which tier ran.
- **0.2.8** — **panic context spill**: compaction failure no longer stalls
  the session. New ladder: hot → **cold recovery** (one full-prefill
  attempt with the synthesized system, our protocol) → **model-free panic
  spill** (previous summary as head-ups + archive index + explicit
  "NOT summarized — pull up via `history_pull`" warning). The session
  continues immediately from the spill doc at reduced fidelity; the spilled
  region stays fully pullable. The full dump file (0.2.7) is still written
  as the off-session artifact. Triggered on any failure: drift,
  non-compliance, provider errors, no model, no system prompt.
- **0.2.7** — **fail-closed, no legacy fallback** (user design rule): on
  any compaction failure (drift, non-compliance after retry, provider
  error, no model, no system prompt) the extension now dumps everything to
  `~/.pi/agent/lazy-compact/dumps/<sessionId>-<ts>.md` — metadata, the
  previous compaction summary, the archive index, and the full
  compaction-aware session context — then tells the user to start a new
  session and salvage from the dump, and cancels the compaction so the
  session is never silently re-summarized by the legacy path. Rationale:
  at the context ceiling the legacy path is a 50–60k-token full prefill
  that can itself 400; a clean dump + manual salvage beats a possibly-worse
  automatic summary. Aborts remain clean cancels (no dump).

- **0.2.6** — `usage.cost` survives the retry merge. pi 1.5.0's TUI footer
  reads `usage.cost.total` unconditionally; the old top-level-numeric-only
  `sumUsage` silently dropped the nested `cost` object on the retry path,
  and the stored compaction entry then crashed the 1.5.0 render loop
  (`TypeError: Cannot read properties of undefined (reading 'total')`).
  `sumUsage` now merges `cost` leaf-wise (numbers summed, non-numbers
  kept). Entries written before this fix are repaired once with
  `python3 scripts/repair-sessions.py` (idempotent).
- **0.2.5** — ceiling-aware request sizing, aligned to pi's compaction
  math: prompt estimated with pi's exported `estimateTokens()` (per
  message, conservative); output budget = remaining context headroom
  (`contextWindow − promptTokens`, floor 2048) — the same approach as pi's
  own summarization call (#9512), which at the compaction trigger point is
  ≈ `compaction.reserveTokens`; the retry only fires when
  `usage.input + usage.output + estimateTokens(retrial) < contextWindow`
  (otherwise it says so and goes straight to legacy instead of 400-ing);
  a `<compaction_summary>` block clipped at `stopReason: "length"` is
  accepted and flagged `(truncated at output limit)` — an unclosed block
  with `stopReason: "stop"` is still non-compliant.
- **0.2.4** — forceful protocol message for weak/local models: opens with
  `STOP. STOP. STOP. / This is NOT a user message`, closes with
  `GENERATE THE COMPACTION SUMMARY NOW` (primacy + recency); the tool-call
  option explicitly says FILL the `summary` argument (never empty);
  non-compliance notifications include the first 200 chars of the model's
  actual reply.
- **0.2.3** — dual-contract ack: the `compact_ack` tool call is preferred,
  but a summary wrapped in `<compaction_summary> … </compaction_summary>`
  is also accepted when no tool call is present (deterministic validation:
  well-formed marker, min length). Pinned tool templates unchanged.
- **0.2.2** — disk-persisted snapshot (`~/.pi/agent/lazy-compact/
  <sessionId>.json`, written on every live call, restored + lineage-
  validated at compaction) so the hot path survives pi restart/`/reload`
  while the llama.cpp cache is still warm; clean abort handling (no retry
  on a dead signal, `{cancel: true}`, no false "non-compliance").
- **0.2.1** — cold-start path: compaction before any LLM call in-process
  (resume/fork of an already-large session) synthesizes the leading system
  message from `getSystemPrompt()` + the `compact_ack` declaration instead
  of warning and falling back.
- **0.2.0** — drift guard fixed: replaced the always-false snapshot-leaf
  check with a prefix-lineage scan over raw branch entries.

### Install

```bash
# already done on this machine (symlink, auto-discovered via package.json
# `pi.extensions` manifest):
ln -s ~/pi-ext/packages/pi-lazy-compact ~/.pi/agent/extensions/pi-lazy-compact
# then /reload inside pi (or just start pi)
```

Or `pi install npm:pi-lazy-compact` once published. Smoke-tested:
a fresh session's declared tool list is
`read, bash, edit, write, compact_ack, history_pull` — the pinned template
is live.

### Trying it on a real case

1. Run a normal long session (any task; ~20+ turns or until the context
   threshold approaches).
2. Trigger compaction: `/compact` (or let the threshold fire).
3. Expected notifications: `lazy-compact: hot compaction OK — N archive
   spans, summary M chars`. Any `falling back to pi's default (legacy)
   …` line tells you which guard fired.
4. In the next turn, ask for something that only the summarized region
   contains (an exact earlier error message, a command you ran, a file's
   earlier state). The model should call `history_pull` with an Archive span
   and answer from the pulled raw text.
5. Check the session file: the compaction entry's `summary` starts with
   `# Session summary (lazy-compact)` and has the Archive section; its
   `usage` shows the hot call's token accounting (mostly cache reads on a
   real caching provider).

### Known hazards (v1)

- **Cache TTL**: the hot request must run while the live prefix is still
  warm. Compaction fires at threshold/overflow (prefix is seconds old —
  fine); a manual `/compact` hours after the last turn can miss TTL and pay
  a fresh prefill — correct, just not cheap.
- **Anthropic thinking budgets**: with budget-based thinking the cache key
  includes `budget_tokens` derived from `max_tokens` (see
  `dist/core/cache-warmer.js` `isReplayable`). The hot call uses
  `maxTokens: 8192`; if the live session runs a different thinking budget,
  the *thinking dimension* of the key may differ. Watch the usage numbers on
  the first real run.
- **Tool-generation drift**: if the tool list changes after the snapshot
  (tool_search load, MCP toggle), the replay carries the stale leading
  system message → correct content, degraded cache. The leaf/prompt/model
  guards catch the common cases; the rest degrades gracefully.
- **Summary quality depends on the model's compliance**: that is exactly
  what the ladder is for — worst case is stock pi compaction.
- The post-compaction rebuild (prefill 2) still happens — it is inherent to
  any middle-deletion; it just rebuilds the *small* context.
