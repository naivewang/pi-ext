/**
 * PART A of LAZY COMPACTION — "hot summary": generate the compaction summary as a side-channel
 * request that is a STRICT PREFIX EXTENSION of the last live agent request
 * (same model, same system prompt, same messages, plus one appended
 * instruction), instead of pi's current fresh prompt
 * (separate summarization system prompt + serialized span, cacheRetention
 * "none").
 *
 * What is proven (no real LLM involved — the provider is a prefix-cache
 * oracle, see fake/provider.ts):
 *
 *   1. legacy shape  : zero cache reuse, full prefill of the span, no cache write
 *   2. hot shape     : the ENTIRE live context is a cache read; only the
 *                      appended instruction is prefilled fresh
 *   3. hot is a strict prefix extension of the last live request
 *   4. the side channel never leaks into the agent context; the
 *      post-compaction rebuild (prefill 2) remains, but is the small
 *      post-compaction context
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeGrownScenario, SYSTEM, BASE_TOOLS } from "./fake/agent.ts";
import { serializeMessage, type Prompt } from "./fake/provider.ts";
import type { Message } from "./fake/session.ts";

// pi's current summarization prompt shape (dist/core/compaction/compaction.js:
// buildSummarizationContext — different system prompt, one user message with
// the serialized conversation, completeSummarization — cacheRetention "none").
const SUMMARIZATION_SYSTEM_PROMPT =
	"You are a conversation summarization engine. Summarize the conversation provided by the user.";

const SUMMARIZE_INSTRUCTION = `Summarize the conversation above using EXACTLY this format:
## Goal
## Constraints & Preferences
## Progress
## Key Decisions
## Next Steps
## Critical Context
Output only the summary. Do not call tools. Do not continue the conversation.`;

// Same instruction, but addressed to a model that is ALREADY inside the live
// conversation (the hot-compact variant).
const HOT_INSTRUCTION = `STOP the normal task. Summarize this ENTIRE conversation — everything above, including your own tool calls and their results — using EXACTLY this format:
## Goal
## Constraints & Preferences
## Progress
## Key Decisions
## Next Steps
## Critical Context
Output only the summary. Do not call tools. Do not continue the task.`;

const CANNED_SUMMARY = `## Goal
Build the retry pipeline for the scheduler.
## Constraints & Preferences
- none stated
## Progress
### Done
- [x] steps 0-3 executed, all green
## Key Decisions
- **exponential backoff**: user rejected fixed interval
## Next Steps
1. write tests for the retry loop
## Critical Context
- step 3 build output carried 2 warnings`;

/** pi's legacy summary prompt: separate system + serialized span, nothing shared with the live context. */
function legacySummarizationPrompt(messagesToSummarize: Message[]): Prompt {
	const span = messagesToSummarize.map((m) => serializeMessage(m)).join("\n");
	return {
		system: SUMMARIZATION_SYSTEM_PROMPT,
		messages: [{ role: "user", content: `${span}\n\n${SUMMARIZE_INSTRUCTION}` }],
	};
}

test("legacy compaction (pi today): full prefill, zero cache reuse, no cache write", () => {
	const s = makeGrownScenario(16);
	const lastLive = s.live[s.live.length - 1];

	// pi summarizes everything except the kept tail (last 2 messages here).
	const msgs = s.session.messageEntries();
	const toSummarize = msgs.slice(0, msgs.length - 2).map((e) => e.message);

	const rec = s.provider.complete(
		"legacy-summary",
		legacySummarizationPrompt(toSummarize),
		{ cacheRetention: "none", response: CANNED_SUMMARY },
	);

	assert.equal(rec.cacheRead, 0, "different system prompt => shares no prefix with the live context");
	assert.equal(rec.freshInput, rec.serialized.length, "the entire serialized span is prefilled fresh");
	assert.ok(
		rec.freshInput > 0.8 * lastLive.serialized.length,
		`span is ~the whole context (fresh=${rec.freshInput} vs live total=${lastLive.serialized.length})`,
	);

	// cacheRetention "none": the one-off prompt writes nothing — a repeat
	// costs the full prefill again.
	const again = s.provider.complete(
		"legacy-summary (repeat)",
		legacySummarizationPrompt(toSummarize),
		{ cacheRetention: "none", response: CANNED_SUMMARY },
	);
	assert.equal(again.cacheRead, 0, "one-off prompt wrote no cache entry");
});

test("hot compaction: the summary request is a strict prefix extension of the live context", () => {
	const s = makeGrownScenario(16);
	const lastLive = s.live[s.live.length - 1];

	// Same system, same messages as the last live request, + the instruction.
	const hotPrompt: Prompt = {
		system: s.system,
		tools: BASE_TOOLS,
		messages: [...s.session.projectContext(), { role: "user", content: HOT_INSTRUCTION }],
	};
	const rec = s.provider.complete("hot-summary", hotPrompt, { response: CANNED_SUMMARY });

	assert.ok(rec.serialized.startsWith(lastLive.serialized), "hot request strictly extends the last live request");
	assert.equal(rec.cacheRead, lastLive.serialized.length, "entire live context served from the prefix cache");

	const fresh = rec.freshInput;
	assert.equal(fresh, rec.serialized.length - lastLive.serialized.length);
	assert.ok(fresh < 1000, `only the appended instruction is prefilled fresh (${fresh} chars)`);
	assert.ok(fresh < 0.02 * lastLive.serialized.length, "fresh prefill < 2% of the live context");

	console.log(`\nhot-compact: live total=${lastLive.serialized.length}, summary fresh=${fresh}\n${s.provider.report()}`);
});

test("hot vs legacy: fresh prefill for the summary drops to ~0", () => {
	// Two identical grown scenarios, one per strategy.
	const a = makeGrownScenario(16);
	const b = makeGrownScenario(16);

	const msgs = a.session.messageEntries();
	const legacy = a.provider.complete(
		"legacy-summary",
		legacySummarizationPrompt(msgs.slice(0, msgs.length - 2).map((e) => e.message)),
		{ cacheRetention: "none", response: CANNED_SUMMARY },
	);

	const hot = b.provider.complete("hot-summary", {
		system: b.system,
		tools: BASE_TOOLS,
		messages: [...b.session.projectContext(), { role: "user", content: HOT_INSTRUCTION }],
	}, { response: CANNED_SUMMARY });

	assert.ok(hot.freshInput < 0.05 * legacy.freshInput, `hot fresh (${hot.freshInput}) << legacy fresh (${legacy.freshInput})`);
	console.log(`\ncost of the summary call — legacy fresh=${legacy.freshInput} (cacheRead=${legacy.cacheRead}); hot fresh=${hot.freshInput} (cacheRead=${hot.cacheRead})`);
});

test("post-compaction turn: prefill 2 remains (unavoidable), no side-channel leak", () => {
	const s = makeGrownScenario(16);
	const lastLive = s.live[s.live.length - 1];

	const rec = s.provider.complete("hot-summary", {
		system: s.system,
		tools: BASE_TOOLS,
		messages: [...s.session.projectContext(), { role: "user", content: HOT_INSTRUCTION }],
	}, { response: CANNED_SUMMARY });
	assert.ok(rec.serialized.startsWith(lastLive.serialized), "precondition: hot summary on the hot prefix");

	// pi's bookkeeping: append the CompactionEntry, rebuild context for the
	// next request. Keep the last 2 messages as the tail.
	const msgs = s.session.messageEntries();
	s.session.addCompaction(CANNED_SUMMARY, msgs[msgs.length - 2].id);

	const post = s.provider.complete("post-compact turn", { system: s.system, tools: BASE_TOOLS, messages: s.session.projectContext() });

	// Prefill 2: the summary is inserted BEFORE the kept tail, so the rebuilt
	// context is not a prefix extension of anything live. That is the price
	// of any middle-deletion — but it is now the SMALL post-compaction context.
	assert.ok(!post.serialized.startsWith(lastLive.serialized), "rebuild is not a prefix extension (prefill 2)");
	assert.ok(post.freshInput > 0.9 * post.serialized.length, "rebuild is effectively a full prefill");
	assert.ok(post.serialized.length < lastLive.serialized.length, "...of the small post-compaction context");

	// The side channel stays out of the agent context: no instruction entry,
	// no instruction text in the next request.
	assert.equal(
		s.session.entries.filter((e) => e.type === "message" && e.message.content === HOT_INSTRUCTION).length,
		0,
		"the instruction was not persisted as a session message",
	);
	assert.ok(!post.serialized.includes("STOP the normal task"), "instruction never enters the rebuilt context");
});
