/**
 * PART B of LAZY COMPACTION — "archive + on-demand pull": the compaction
 * summary is a two-tier document —
 * head-ups (always in-context) + an Archive of addressable skim lines
 * ("[A2] entries e6-e9: retry loop implementation; final state all green").
 * The agent pulls an entry's detail up ON DEMAND via a history_pull tool;
 * the pulled chunk lands at the TAIL of the prompt as a tool result.
 *
 * Design rule under test: between compactions the prompt is APPEND-ONLY.
 * A consumed archive line is NOT dropped at pull-up time (that would edit
 * the prompt mid-session and bust the cache); the drop is batched into the
 * NEXT compaction, which rewrites the summary document anyway.
 *
 * Proven (same prefix-cache oracle as part A):
 *
 *   1. pull-up turns extend every previous request — cache stays warm, and
 *      the fresh prefill of the pull-up request is EXACTLY the pulled
 *      detail (the "lazy prefill" pays only for what it pulls)
 *   2. counter-example: dropping the pulled line immediately (naive
 *      consume) is not a prefix extension -> full re-prefill, including
 *      the chunk that was just paid for
 *   3. the next compaction batches the rewrite (one full prefill of the
 *      small context); consumed line dropped, un-consumed line carried,
 *      essence absorbed into head-ups; the append-only chain resumes
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeGrownScenario, pullUpMessages, fakeOutput, BASE_TOOLS, type Scenario } from "./fake/agent.ts";
import { serializeMessage, type RequestRecord } from "./fake/provider.ts";
import type { Message } from "./fake/session.ts";

// v1: produced at the first compaction (summary generation itself is part 1's
// job — here we just install the document, the format is what matters).
const DOC_V1 = `## Head-ups
- Decision: retry uses exponential backoff (user rejected fixed interval)
- Open: flaky test in scheduler.spec.ts

## Archive (pull up with history_pull; each line is one pull-up-able unit)
- [A1] entries e2-e5: explored 3 approaches; rejected A (perf), B (new deps)
- [A2] entries e6-e9: retry loop implementation; final state all green`;

// What history_pull(A2) returns: the raw archived span, wrapped as reference material.
const A2_CHUNK = [
	"<archive entries e6-e9 — pulled on demand>",
	`[assistant] running step 2 toolCall=bash({"command":"make step2"})`,
	`[toolResult] ${fakeOutput(2)}`,
	`[assistant] running step 3 toolCall=bash({"command":"make step3"})`,
	`[toolResult] ${fakeOutput(3)}`,
	"</archive>",
].join("\n");

// v2: produced at the SECOND compaction — A2's essence absorbed into
// head-ups, A2 line dropped (it was consumed), A1 line carried forward.
const DOC_V2 = `## Head-ups
- Decision: retry uses exponential backoff (user rejected fixed interval)
- Done: retry loop implementation complete, all green (absorbed from pulled A2)
- Open: flaky test in scheduler.spec.ts

## Archive (pull up with history_pull; each line is one pull-up-able unit)
- [A1] entries e2-e5: explored 3 approaches; rejected A (perf), B (new deps)`;

interface PullUpState {
	s: Scenario;
	/** request index of the first post-compaction turn (r1) */
	segStart: number;
	r1: RequestRecord;
	r2: RequestRecord;
	pull: { call: Message; result: Message };
	pullCallEntryId: string;
}

/**
 * Grow -> compact (DOC_V1, keep last 2 messages) -> r1 (model pulls A2) ->
 * append tool call + chunk -> r2 (model answers) -> append answer.
 *
 * Session after this: e1..e10 (grow), compaction e11, pull call e12,
 * chunk e13, answer e14.
 */
function setupToPullUp(): PullUpState {
	const s = makeGrownScenario(4);
	const msgs = s.session.messageEntries();
	assert.equal(msgs.length, 10, "e1 user + 4 rounds x 2 + final answer");

	// keep the last two messages (e9, e10)
	s.session.addCompaction(DOC_V1, msgs[msgs.length - 2].id);

	// r1: first post-compaction turn; the model decides to pull up A2.
	const r1 = s.provider.complete("post-compact r1", { system: s.system, tools: BASE_TOOLS, messages: s.session.projectContext() });
	const pull = pullUpMessages(A2_CHUNK);
	const callEntry = s.session.addMessage(pull.call);
	s.session.addMessage(pull.result);

	// r2: the pull-up landed; the request must be r1 + [call, chunk].
	const r2 = s.provider.complete(
		"post-compact r2",
		{ system: s.system, tools: BASE_TOOLS, messages: s.session.projectContext() },
		{ response: "verified against the archive" },
	);
	s.session.addMessage({ role: "assistant", content: "verified against the archive" });

	return { s, segStart: r1.index, r1, r2, pull, pullCallEntryId: callEntry.id };
}

test("pull-up is append-only: chain stays warm, fresh prefill == the pulled detail", () => {
	const st = setupToPullUp();
	const { s, r1, r2, pull } = st;

	// r1 is the expected one-time rebuild (summary inserted before the kept
	// tail) — full prefill of the small post-compaction context.
	assert.equal(r1.freshInput, r1.serialized.length, "r1: one-time rebuild of the post-compaction context");

	// r2 = r1 + [history_pull call, chunk]: a strict prefix extension.
	assert.ok(r2.extendsPrevious, "the pull-up request extends r1");
	assert.equal(r2.cacheRead, r1.serialized.length, "everything before the pull-up is a cache read");

	// The fresh prefill is EXACTLY the appended pull-up material.
	// r2.serialized = r1.serialized + "\n" + ser(call) + "\n" + ser(result)
	const expectedFresh = serializeMessage(pull.call).length + serializeMessage(pull.result).length + 2;
	assert.equal(r2.freshInput, expectedFresh, "lazy prefill pays exactly for the pulled detail");
	assert.ok(r2.freshInput >= A2_CHUNK.length && r2.freshInput < A2_CHUNK.length * 1.5, "the chunk dominates the fresh prefill");

	// Grow phase was a chain too; post-compaction segment is a chain too.
	for (let i = 1; i < s.live.length; i++) assert.ok(s.live[i].extendsPrevious, `grow phase request #${i} extends`);
	s.provider.assertPrefixChain(st.segStart, "post-compaction segment", r2.index + 1);

	// The consumed line is NOT dropped at pull-up time — it stays until the
	// next compaction (dropping it now is the cache-busting move, see below).
	const doc = s.session.projectContext()[0].content;
	assert.ok(doc.includes("[A2] entries e6-e9"), "A2 line still in the archive after pull-up");
	assert.ok(doc.includes("[A1] entries e2-e5"), "A1 line untouched");

	console.log(`\nlazy-reload pull-up — chunk=${A2_CHUNK.length} chars, r2 fresh=${r2.freshInput} (cacheRead=${r2.cacheRead})\n${s.provider.report()}`);
});

test("counter-example: dropping the pulled line immediately busts the cache", () => {
	const st = setupToPullUp();
	const { s, r1, r2 } = st;

	// The naive implementation: mark A2 consumed by REWRITING the summary
	// right after the pull-up.
	const c = s.session.latestCompaction()!;
	c.summary = DOC_V1.replace(/\n- \[A2\].*$/, "");

	const r3 = s.provider.complete("after naive consume", { system: s.system, tools: BASE_TOOLS, messages: s.session.projectContext() });

	assert.ok(!r3.extendsPrevious, "editing the summary at slot 1 is not a prefix extension");
	assert.equal(r3.cacheRead, 0, "sim: no cached prompt is a prefix of the rewritten one (real providers credit only up to the divergence point — still, everything after it re-prefills)");
	assert.ok(r3.freshInput > A2_CHUNK.length, "re-prefills the pulled chunk that r2 already paid for");
	assert.ok(r3.freshInput > r2.freshInput + r1.serialized.length * 0.5, "far more expensive than the pull-up itself");

	console.log(`\nnaive consume — r3 fresh=${r3.freshInput} vs pull-up r2 fresh=${r2.freshInput} (r2 cacheRead=${r2.cacheRead})\n${s.provider.report()}`);
});

test("next compaction batches the rewrite: drop consumed, carry un-consumed, chain resumes", () => {
	const st = setupToPullUp();
	const { s, r1, r2 } = st;

	// Second compaction: the summary document is rewritten anyway, so the
	// consumed-line drop + essence absorption cost nothing extra. Keep the
	// pull-up exchange as the new tail.
	s.session.addCompaction(DOC_V2, st.pullCallEntryId);
	const r3 = s.provider.complete("compaction-2 turn", { system: s.system, tools: BASE_TOOLS, messages: s.session.projectContext() });

	// The one and only batched rewrite: full prefill, of the small context.
	assert.ok(!r3.extendsPrevious, "the compaction rewrite is the single non-extension between chains");
	assert.ok(r3.freshInput > 0.9 * r3.serialized.length);
	assert.ok(r3.serialized.length < r2.serialized.length, "smaller than the pre-compaction request");

	// Document invariants.
	assert.ok(!DOC_V2.includes("[A2]"), "consumed line dropped");
	assert.ok(DOC_V2.includes("[A1]"), "un-consumed line carried forward");
	assert.ok(DOC_V2.includes("absorbed from pulled A2"), "pulled essence absorbed into head-ups");

	// Append-only regime resumes.
	s.session.addMessage({ role: "assistant", content: "next: write the tests" });
	const r4 = s.provider.complete("post-compact-2 turn", { system: s.system, tools: BASE_TOOLS, messages: s.session.projectContext() });
	assert.ok(r4.extendsPrevious, "prefix chain resumes after the batched rewrite");
	assert.equal(r4.cacheRead, r3.serialized.length);

	console.log(`\nbatched rewrite — r3 fresh=${r3.freshInput} (total=${r3.serialized.length}), r4 cacheRead=${r4.cacheRead}\n${s.provider.report()}`);
});
