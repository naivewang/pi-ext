/**
 * PART C — the pinned tool template.
 *
 * Real providers serialize `tools` BEFORE the messages — the tool list is
 * inside the cache key (and pi rebuilds the system prompt with the tool
 * names too, so a tool change touches TWO prefix elements). Lazy compaction
 * therefore bundles both protocol tools into the template at session start:
 *
 *   template = [steady-state tools, compact_ack, history_pull]   // never changes
 *
 * Both tools are extension-registered (no MCP server race), tiny, and
 * protocol-critical — declaring them from turn 0 costs ~100 tokens/turn and
 * buys the strongest invariant: ONE tool list for the whole session, so the
 * only prefix breaks are compaction rebuilds.
 *
 * Rules proven here:
 *   C1 (bundled): one template for life — live turns, the hot summary
 *      request, post-compact rebuilds and all pulls share it byte-for-byte;
 *      the only non-extensions are the compaction rebuilds.
 *   C2 (general law): a mid-session tool change busts the cache like any
 *      mid-prompt edit.
 *   C3 (compact_ack trap): the ack tool cannot be injected only into the
 *      summary request — the prefix diverges at the tool list and the entire
 *      hot prefix is lost. (It COULD be deferred to a rebuild boundary like
 *      history_pull, but then the FIRST hot summary of the session would
 *      miss — hence: from turn 0.)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	makeGrownScenario,
	pullUpMessages,
	fakeOutput,
	BASE_TOOLS,
	COMPACT_ACK_TOOL,
	HISTORY_PULL_TOOL,
} from "./fake/agent.ts";

/** The pinned template: steady-state tools + both protocol tools, from session start. */
const TEMPLATE = [...BASE_TOOLS, COMPACT_ACK_TOOL, HISTORY_PULL_TOOL];

const DOC = `## Head-ups
- Decision: retry uses exponential backoff

## Archive (pull up with history_pull)
- [A1] entries e2-e5: explored 3 approaches; rejected A (perf), B (deps)
- [A2] entries e6-e9: retry loop implementation; final state all green`;

const CHUNK_A2 = [`<archive entries e6-e9>`, `[toolResult] ${fakeOutput(2)}`, `[toolResult] ${fakeOutput(3)}`, `</archive>`].join("\n");
const CHUNK_A1 = [`<archive entries e2-e5>`, `[toolResult] ${fakeOutput(0)}`, `[toolResult] ${fakeOutput(1)}`, `</archive>`].join("\n");

test("C1 bundled template: one tool list for life; only compaction rebuilds break the chain", () => {
	const s = makeGrownScenario(4, TEMPLATE);
	const last = s.live[s.live.length - 1];

	// The hot summary request carries the SAME template (the whole point of
	// bundling: nothing has to change for it).
	const hot = s.provider.complete(
		"hot-summary",
		{
			system: s.system,
			tools: TEMPLATE,
			messages: [...s.session.projectContext(), { role: "user", content: "call compact_ack with the summary of this conversation" }],
		},
		{ response: "compact_ack({...})" },
	);
	assert.ok(hot.serialized.startsWith(last.serialized), "hot summary still strictly extends the live request");
	assert.equal(hot.cacheRead, last.serialized.length);

	// Compaction rebuild with the same template.
	const msgs = s.session.messageEntries();
	s.session.addCompaction(DOC, msgs[msgs.length - 2].id);
	const r1 = s.provider.complete("post-compact r1", { system: s.system, tools: TEMPLATE, messages: s.session.projectContext() });
	assert.ok(!r1.extendsPrevious, "the rebuild is the expected break");

	// Two incremental pulls, same template.
	for (const [label, chunk, id] of [
		["pull A2", CHUNK_A2, "e6"],
		["pull A1", CHUNK_A1, "e2"],
	] as const) {
		const p = pullUpMessages(chunk, id);
		s.session.addMessage(p.call);
		s.session.addMessage(p.result);
		const r = s.provider.complete(label, { system: s.system, tools: TEMPLATE, messages: s.session.projectContext() });
		assert.ok(r.extendsPrevious, `${label} is a pure prefix extension`);
	}

	// The template is byte-identical across EVERY request of the session.
	for (const r of s.provider.requests) assert.deepEqual(r.prompt.tools, TEMPLATE, `request ${r.label}: template unchanged`);

	// Exactly one break in the whole session: the compaction rebuild.
	const breaks = s.provider.requests.filter((r, i) => i > 0 && !r.extendsPrevious).map((r) => r.label);
	assert.deepEqual(breaks, ["post-compact r1"], "only the compaction rebuild breaks the prefix chain");

	console.log(`\nC1 bundled template — hot fresh=${hot.freshInput} (cacheRead=${hot.cacheRead}); breaks=${JSON.stringify(breaks)}\n${s.provider.report()}`);
});

test("C2 general law: a mid-session tool change busts the cache", () => {
	const s = makeGrownScenario(4);
	const ctx = s.session.projectContext();

	const same = s.provider.complete("next turn, same tools", { system: s.system, tools: BASE_TOOLS, messages: ctx });
	assert.ok(same.extendsPrevious, "unchanged tool list keeps the chain warm");

	const added = s.provider.complete("next turn, tool added", {
		system: s.system,
		tools: [...BASE_TOOLS, "grep(pattern: string)"],
		messages: ctx,
	});
	assert.ok(!added.extendsPrevious, "adding a tool mid-session diverges at the tool list");
	assert.equal(added.cacheRead, 0, "the whole prompt re-prefills (sim: no whole-prompt prefix match)");
});

test("C3 compact_ack trap: injecting it only for the summary request loses the hot prefix", () => {
	// Live requests WITHOUT compact_ack; the summary request tries to add it.
	const t = makeGrownScenario(4);
	const lastT = t.live[t.live.length - 1];
	const bad = t.provider.complete(
		"hot-summary (ack injected)",
		{
			system: t.system,
			tools: [...BASE_TOOLS, COMPACT_ACK_TOOL],
			messages: [...t.session.projectContext(), { role: "user", content: "call compact_ack with the summary of this conversation" }],
		},
		{ response: "compact_ack({...})" },
	);
	assert.ok(!bad.serialized.startsWith(lastT.serialized), "tool added only for the summary request => not a prefix extension");
	assert.equal(bad.cacheRead, 0, "the entire hot prefix is lost — part A evaporates");

	// (Alternative, cache-free but weaker: register at a rebuild boundary,
	// like history_pull. Then the first hot summary of the session misses,
	// and every later one hits — acceptable only if you accept one cold
	// summary. Bundling from turn 0 is simpler and strictly better here.)
	console.log(`\nC3 trap — injected: fresh=${bad.freshInput} (cacheRead=${bad.cacheRead})`);
});
