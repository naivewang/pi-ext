/**
 * Part D — the compact_ack protocol ladder (pure logic, no pi, no LLM).
 *
 * The real extension (extensions/lazy-compact.ts) wires this logic to pi:
 *   1. postfix hot request  → extractAck
 *   2. non-compliant        → one cache-warm retry (offender + re-instruction)
 *   3. still non-compliant  → legacy fallback (pi's default compaction)
 * Here we prove the decision logic: what counts as compliance, what the
 * protocol messages demand, and how the archive document is built.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	ACK_TOOL_NAME,
	MAX_PULL_CHARS,
	MIN_SUMMARY_CHARS,
	SUMMARY_CLOSE,
	SUMMARY_OPEN,
	buildArchiveIndex,
	buildColdSystemMessage,
	buildCompactionDoc,
	buildSpillDump,
	buildSpillDoc,
	parseSpillDoc,
	extractAck,
	isPrefixLineageIntact,
	makeInstruction,
	restoreSnapshotJson,
	makeRetrial,
	spanEndId,
	sumUsage,
	truncate,
	type AckResponse,
	type EntryLike,
} from "../extensions/lazy-compact-core.ts";

const GOOD_SUMMARY = "## Goal\nBuild X.\n\n## Progress\n- did A, did B with file facts.\n\n## Next steps\n- C";

function ackResp(summary: string): AckResponse {
	return {
		stopReason: "toolUse",
		content: [{ type: "toolCall", name: ACK_TOOL_NAME, arguments: { summary } }],
	};
}

test("extractAck: compliant tool call passes", () => {
	const v = extractAck(ackResp(GOOD_SUMMARY));
	assert.equal(v.ok, true);
	if (v.ok) assert.equal(v.summary, GOOD_SUMMARY);
});

test("extractAck: plain text reply is non-compliant (reason names both options)", () => {
	const v = extractAck({
		stopReason: "stop",
		content: [{ type: "text", text: "Sure, here is the summary: ..." }],
	});
	assert.equal(v.ok, false);
	if (!v.ok) {
		assert.match(v.reason, /compact_ack/);
		assert.match(v.reason, /compaction_summary/);
		assert.match(v.offenderText, /Sure, here is the summary/);
	}
});

test("extractAck: marked text summary is compliant (dual contract)", () => {
	const v = extractAck({
		stopReason: "stop",
		content: [{ type: "text", text: `Sure!\n${SUMMARY_OPEN}\n${GOOD_SUMMARY}\n${SUMMARY_CLOSE}` }],
	});
	assert.equal(v.ok, true);
	if (v.ok) assert.equal(v.summary, GOOD_SUMMARY);
});

test("extractAck: marked summary is trimmed and length-checked", () => {
	const v = extractAck({
		stopReason: "stop",
		content: [{ type: "text", text: `${SUMMARY_OPEN}\n  short  \n${SUMMARY_CLOSE}` }],
	});
	assert.equal(v.ok, false);
	if (!v.ok) assert.match(v.reason, /marked summary too short/);
});

test("extractAck: marker clipped at output limit is accepted (truncated flag)", () => {
	const v = extractAck({
		stopReason: "length",
		content: [{ type: "text", text: `${SUMMARY_OPEN}\n${GOOD_SUMMARY}` }],
	});
	assert.equal(v.ok, true);
	if (v.ok) {
		assert.equal(v.truncated, true);
		assert.equal(v.summary, GOOD_SUMMARY);
	}
});

test("extractAck: unclosed marker without length clip is non-compliant", () => {
	const v = extractAck({
		stopReason: "stop",
		content: [{ type: "text", text: `${SUMMARY_OPEN}\n${GOOD_SUMMARY}` }],
	});
	assert.equal(v.ok, false);
	if (!v.ok) assert.match(v.reason, /never closed/);
});

test("extractAck: tool call takes precedence over marker", () => {
	const resp: AckResponse = {
		stopReason: "toolUse",
		content: [
			{ type: "text", text: `${SUMMARY_OPEN}\n${GOOD_SUMMARY}\n${SUMMARY_CLOSE}` },
			{ type: "toolCall", name: ACK_TOOL_NAME, arguments: { summary: GOOD_SUMMARY + "-via-tool" } },
		],
	};
	const v = extractAck(resp);
	assert.equal(v.ok, true);
	if (v.ok) assert.equal(v.summary, GOOD_SUMMARY + "-via-tool");
});

test("extractAck: wrong tool is non-compliant (reason mentions tool)", () => {
	const v = extractAck({
		stopReason: "toolUse",
		content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }],
	});
	assert.equal(v.ok, false);
	if (!v.ok) assert.match(v.reason, /tool other than compact_ack/);
});

test("extractAck: short summary is non-compliant (junk doc guard)", () => {
	const v = extractAck(ackResp("ok done"));
	assert.equal(v.ok, false);
	if (!v.ok) assert.match(v.reason, /too short/);
});

test("extractAck: provider error is non-compliant", () => {
	const v = extractAck({ stopReason: "error", content: [], errorMessage: "boom" });
	assert.equal(v.ok, false);
	if (!v.ok) assert.match(v.reason, /provider error/);
});

test("extractAck: missing/undefined response is non-compliant", () => {
	assert.equal(extractAck(undefined).ok, false);
	const v = extractAck(ackResp(""));
	assert.equal(v.ok, false);
});

test("extractAck: summary at the minimum passes, one char under fails", () => {
	const atMin = "x".repeat(MIN_SUMMARY_CHARS);
	assert.equal(extractAck(ackResp(atMin)).ok, true);
	assert.equal(extractAck(ackResp("x".repeat(MIN_SUMMARY_CHARS - 1))).ok, false);
});

test("instruction: forceful + dual contract — tool call preferred, marked text accepted", () => {
	const i = makeInstruction();
	assert.match(i, /STOP\. STOP\. STOP\./);
	assert.match(i, /This is NOT a user message/);
	assert.match(i, new RegExp(ACK_TOOL_NAME));
	assert.match(i, /in order of preference/);
	assert.match(i, /compaction_summary/);
	assert.match(i, /structured markdown/);
	assert.match(i, /Do NOT continue the conversation/);
	assert.match(i, /GENERATE THE COMPACTION SUMMARY NOW/);
});

test("instruction: carries custom /compact instructions when given", () => {
	const i = makeInstruction("focus on the test failures");
	assert.match(i, /User instructions for this compaction/);
	assert.match(i, /focus on the test failures/);
	assert.doesNotMatch(makeInstruction(), /User instructions for this compaction/);
});

test("retrial: names the violation, shows the offender, restates both options", () => {
	const r = makeRetrial("no compact_ack call and no marked block", "I will summarize now…");
	assert.match(r, /did not comply/);
	assert.match(r, /no compact_ack call and no marked block/);
	assert.match(r, /I will summarize now…/);
	assert.match(r, new RegExp(ACK_TOOL_NAME));
	assert.match(r, /compaction_summary/);
});

test("retrial: offender text is capped", () => {
	const long = "y".repeat(5000);
	const r = makeRetrial("short summary", long);
	assert.ok(r.length < 1500);
});

// ---------------------------------------------------------------------------
// Archive index + document
// ---------------------------------------------------------------------------

function msg(id: string, role: string, text: string): EntryLike {
	return { id, type: "message", message: { role, content: [{ type: "text", text }] } };
}

test("buildArchiveIndex: one span per user message, ids are entry ids", () => {
	const entries: EntryLike[] = [
		msg("e1", "user", "build the retry pipeline"),
		msg("e2", "assistant", "ok building…"),
		msg("e3", "toolResult", "done"),
		msg("e4", "user", "fix the flaky test in scheduler.ts"),
		msg("e5", "assistant", "fixed it"),
	];
	const lines = buildArchiveIndex(entries);
	assert.deepEqual(lines, [
		{ from: "e1", to: "e3", label: "build the retry pipeline", entries: 3 },
		{ from: "e4", to: "e5", label: "fix the flaky test in scheduler.ts", entries: 2 },
	]);
});

test("buildArchiveIndex: leading non-user entries form a synthetic span", () => {
	const entries: EntryLike[] = [
		msg("e1", "assistant", "resuming…"),
		msg("e2", "user", "continue with the deploy"),
		msg("e3", "toolResult", "deployed"),
	];
	const lines = buildArchiveIndex(entries);
	assert.equal(lines.length, 2);
	assert.equal(lines[0].from, "e1");
	assert.equal(lines[0].to, "e1");
	assert.equal(lines[1].from, "e2");
	assert.equal(lines[1].to, "e3");
});

test("buildArchiveIndex: non-message entries are ignored", () => {
	const entries: EntryLike[] = [
		{ id: "h1", type: "session_header" },
		msg("e1", "user", "hello"),
		{ id: "m1", type: "model_change" },
		msg("e2", "assistant", "hi"),
	];
	const lines = buildArchiveIndex(entries);
	assert.equal(lines.length, 1);
	assert.equal(lines[0].from, "e1");
	assert.equal(lines[0].to, "e2");
});

test("buildArchiveIndex: empty input", () => {
	assert.deepEqual(buildArchiveIndex([]), []);
});

test("spanEndId: end of the user span, or branch end", () => {
	const entries: EntryLike[] = [
		msg("e1", "user", "a"),
		msg("e2", "assistant", "b"),
		msg("e3", "user", "c"),
		msg("e4", "toolResult", "d"),
	];
	assert.equal(spanEndId(entries, "e1"), "e2");
	assert.equal(spanEndId(entries, "e3"), "e4");
	assert.equal(spanEndId(entries, "nope"), undefined);
});

test("doc: two tiers — head-ups + archive with pull instruction", () => {
	const doc = buildCompactionDoc(
		GOOD_SUMMARY,
		[{ from: "e1", to: "e3", label: "build the retry pipeline", entries: 3 }],
		42000,
	);
	assert.match(doc, /## Head-ups/);
	assert.match(doc, /## Archive/);
	assert.match(doc, /history_pull/);
	assert.match(doc, /\[e1 → e3\] "build the retry pipeline" \(3 entries\)/);
	assert.match(doc, /~42000 tokens/);
});

test("doc: no archive section when there are no spans", () => {
	const doc = buildCompactionDoc(GOOD_SUMMARY, [], 1000);
	assert.doesNotMatch(doc, /## Archive/);
});

// ---------------------------------------------------------------------------
// context spill dump (written on every compaction: full re-read source)
// ---------------------------------------------------------------------------

test("buildSpillDump: carries everything needed to re-read", () => {
	const doc = buildSpillDump({
		sessionId: "sess-1",
		sessionFile: "/sessions/sess-1.jsonl",
		modelId: "qwen3.8-27b",
		tokensBefore: 160000,
		previousSummary: "## Goal\n- old work",
		archive: [{ from: "e1", to: "e9", label: "first message", entries: 9 }],
		transcript: "user: hello\nassistant: hi",
		timestamp: "2026-11-05T00:00:00.000Z",
	});
	assert.match(doc, /context spill dump/);
	assert.match(doc, /session: sess-1/);
	assert.match(doc, /session file: \/sessions\/sess-1.jsonl/);
	assert.match(doc, /model: qwen3\.8-27b/);
	assert.match(doc, /tokensBefore: ~160000/);
	assert.match(doc, /2026-11-05T00:00:00\.000Z/);
	assert.match(doc, /How to re-read/);
	assert.match(doc, /The session CONTINUES/);
	assert.doesNotMatch(doc, /failed:/);
	assert.match(doc, /## Goal\n- old work/);
	assert.match(doc, /\[e1 → e9\] "first message" \(9 entries\)/);
	assert.match(doc, /user: hello\nassistant: hi/);
});

test("buildSpillDump: optional fields degrade cleanly", () => {
	const doc = buildSpillDump({
		sessionId: "s",
		archive: [],
		transcript: "",
	});
	assert.match(doc, /session: s/);
	assert.doesNotMatch(doc, /session file:/);
	assert.doesNotMatch(doc, /Previous compaction summary/);
	assert.doesNotMatch(doc, /Archive index/);
});

// ---------------------------------------------------------------------------
// context spill doc (0.3.1): zero LLM, bounded size — the previous doc is
// flattened, never embedded verbatim
// ---------------------------------------------------------------------------

function nestedSpillDoc(outer: string, inner: string): string {
	// emulate the 0.3.0 bug shape: outer doc embeds inner doc verbatim
	return `# Session summary (lazy-compact — context spill)

Older history was SPILLED — re-read what you need:
1. \`history_pull(from, to?)\` with an Archive span

## Head-ups (previous summary — older history only)

${inner}

## Region digest (deterministic)

- modified: x.ts

## Archive (the spilled region — pull up with history_pull)

- [e${outer.length} → e${outer.length + 5}] "outer region" (6 entries)

~${100000 + outer.length} tokens were spilled into this document.`;
}

test("buildSpillDoc: re-read channels + head-ups + digest + pullable archive (fresh)", () => {
	const doc = buildSpillDoc({
		archive: [
			{ from: "e1", to: "e9", label: "first message", entries: 9 },
			{ from: "e10", to: "e14", label: "second", entries: 5 },
		],
		tokensBefore: 160000,
		dumpPath: "/home/u/.pi/agent/lazy-compact/dumps/sess-1-123.md",
		sessionFile: "/home/u/.pi/agent/sessions/sess-1.jsonl",
		readFiles: ["a.ts", "b.md"],
		modifiedFiles: ["c.ts"],
	});
	assert.match(doc, /context spill/);
	assert.match(doc, /SPILLED, not summarized/);
	assert.match(doc, /Do not assume you remember the spilled region/);
	assert.match(doc, /1\. `history_pull\(from, to\?\)` with a span/);
	assert.match(doc, /2\. Full spill dump: \/home\/u\/\.pi\/agent\/lazy-compact\/dumps\/sess-1-123\.md/);
	assert.match(doc, /3\. Raw session file: \/home\/u\/\.pi\/agent\/sessions\/sess-1\.jsonl/);
	assert.match(doc, /No previous summary exists/);
	assert.match(doc, /## Region digest \(deterministic\)/);
	assert.match(doc, /- read: a\.ts, b\.md/);
	assert.match(doc, /- modified: c\.ts/);
	assert.match(doc, /\[e1 → e9\] "first message" \(9 entries\)/);
	assert.match(doc, /~160000 tokens were spilled into this document/);
	assert.doesNotMatch(doc, /## Past regions/);
	// exactly ONE doc header — no nesting, even fresh
	assert.equal((doc.match(/# Session summary/g) || []).length, 1);
});

test("buildSpillDoc: flattens a nested 0.3.0 doc (the growth bug)", () => {
	const inner = nestedSpillDoc("A", "## Goal\n- oldest work");
	const outer = nestedSpillDoc("BB", inner);
	const doc = buildSpillDoc({
		previousDoc: outer,
		archive: [{ from: "e90", to: "e99", label: "now", entries: 10 }],
		tokensBefore: 123456,
	});
	// no nesting at all — the previous doc is flattened
	assert.equal((doc.match(/# Session summary/g) || []).length, 1);
	assert.equal((doc.match(/## Head-ups/g) || []).length, 1);
	// true (innermost) head-ups survive
	assert.match(doc, /## Goal\n- oldest work/);
	// both older regions folded into compact past lines
	assert.match(doc, /## Past regions \(already spilled — spans still pullable\)/);
	assert.match(doc, /- ~100001 tokens spilled: e1→e6/);
	assert.match(doc, /- ~100002 tokens spilled: e2→e7/);
	// current archive only carries the current region
	const archSection = doc.slice(doc.lastIndexOf("## Archive"));
	assert.match(archSection, /\[e90 → e99\] "now" \(10 entries\)/);
	assert.doesNotMatch(archSection, /e1→e6|e2→e7/);
});

test("buildSpillDoc: bounded growth over a chain of spills", () => {
	let doc: string | undefined;
	const sizes: number[] = [];
	for (let i = 1; i <= 8; i++) {
		doc = buildSpillDoc({
			previousDoc: doc,
			archive: [{ from: "e" + i, to: "e" + (i + 9), label: "msg " + i, entries: 10 }],
			tokensBefore: 100000 + i,
			dumpPath: "/d.md",
		});
		sizes.push(doc.length);
		assert.equal((doc!.match(/# Session summary/g) || []).length, 1, "no nesting at step " + i);
	}
	// each step adds only its past-region line (~80 chars), not the whole previous doc
	const growth = sizes[7] - sizes[0];
	assert.ok(growth < 900, `8 steps grew ${growth} chars — should be ~linear-small`);
});

test("buildSpillDoc: legacy LLM summary carried verbatim as head-ups", () => {
	const doc = buildSpillDoc({
		previousDoc: "## Goal\n- legacy work\n\n## Progress\n- stuff",
		archive: [{ from: "f1", to: "f5", label: "x", entries: 5 }],
		tokensBefore: 42424,
	});
	assert.match(doc, /## Goal\n- legacy work/);
	assert.doesNotMatch(doc, /## Past regions/);
	assert.equal((doc.match(/# Session summary/g) || []).length, 1);
});

test("parseSpillDoc: nested doc → innermost head-ups + ordered regions + zipped tokens", () => {
	const inner = nestedSpillDoc("A", "INNER HEADUPS TEXT");
	const outer = nestedSpillDoc("BB", inner);
	const p = parseSpillDoc(outer);
	assert.equal(p.isSpill, true);
	assert.equal(p.headups, "INNER HEADUPS TEXT");
	assert.equal(p.regions.length, 2);
	assert.deepEqual(p.regions[0], { spans: ["e1→e6"], tokens: 100001 });
	assert.deepEqual(p.regions[1], { spans: ["e2→e7"], tokens: 100002 });
});

test("parseSpillDoc: new-format doc carries past lines; legacy doc is not a spill", () => {
	const fresh = buildSpillDoc({
		previousDoc: "legacy summary text",
		archive: [{ from: "g1", to: "g9", label: "g", entries: 9 }],
		tokensBefore: 77777,
	});
	const p = parseSpillDoc(fresh);
	assert.equal(p.isSpill, true);
	assert.match(p.headups ?? "", /legacy summary text/);
	assert.equal(p.regions.length, 1);
	assert.equal(p.regions[0].tokens, 77777);
	const p2 = parseSpillDoc("just some legacy LLM summary");
	assert.equal(p2.isSpill, false);
	assert.equal(p2.legacySummary, "just some legacy LLM summary");
});

// ---------------------------------------------------------------------------
// disk snapshot restore (survives pi restart / /reload)
// ---------------------------------------------------------------------------

test("restoreSnapshotJson: valid snapshot parses", () => {
	const sys = { role: "system", content: "prompt", toolsAdded: [{ name: "compact_ack" }], timestamp: 0 };
	const json = JSON.stringify({ system: sys, leafId: "abc-123" });
	const s = restoreSnapshotJson(json);
	assert.ok(s);
	assert.deepEqual(s!.system, sys);
	assert.equal(s!.leafId, "abc-123");
});

test("restoreSnapshotJson: malformed file is absent", () => {
	assert.equal(restoreSnapshotJson("{not json"), undefined);
	assert.equal(restoreSnapshotJson(""), undefined);
	assert.equal(restoreSnapshotJson("null"), undefined);
});

test("restoreSnapshotJson: wrong shapes are absent", () => {
	assert.equal(restoreSnapshotJson(JSON.stringify({ system: { role: "user" }, leafId: "x" })), undefined);
	assert.equal(restoreSnapshotJson(JSON.stringify({ leafId: "x" })), undefined);
	assert.equal(restoreSnapshotJson(JSON.stringify({ system: { role: "system" }, leafId: "" })), undefined);
	assert.equal(restoreSnapshotJson(JSON.stringify({ system: { role: "system" }, leafId: 42 })), undefined);
});

// ---------------------------------------------------------------------------
// cold-start system message (compaction before any LLM call in this process)
// ---------------------------------------------------------------------------

test("cold system message: carries prompt + only the compact_ack declaration", () => {
	const tool = { name: ACK_TOOL_NAME, description: "ack", parameters: { type: "object" } };
	const sys = buildColdSystemMessage("You are a coding assistant.", tool);
	assert.equal(sys.role, "system");
	assert.equal(sys.content, "You are a coding assistant.");
	assert.deepEqual(sys.toolsAdded, [tool]);
	assert.equal(sys.timestamp, 0);
});

// ---------------------------------------------------------------------------
// prefix-lineage check (the hot-path drift guard)
// ---------------------------------------------------------------------------

test("lineage: pure message append after the snapshot is intact", () => {
	const entries: EntryLike[] = [
		msg("e1", "user", "a"),
		{ id: "snap", type: "message", message: { role: "toolResult", content: [] } },
		msg("e2", "assistant", "b"), // the turn's final answer, appended AFTER the last request
	];
	assert.deepEqual(isPrefixLineageIntact(entries, "snap"), { ok: true });
});

test("lineage: metadata appends (usage/label/session_info/custom_message) are intact", () => {
	const entries: EntryLike[] = [
		{ id: "snap", type: "message", message: { role: "assistant", content: [] } },
		{ id: "u1", type: "usage" },
		{ id: "l1", type: "label" },
		{ id: "s1", type: "session_info" },
		{ id: "c1", type: "custom_message" },
	];
	assert.deepEqual(isPrefixLineageIntact(entries, "snap"), { ok: true });
});

test("lineage: snapshot leaf being the last entry is intact", () => {
	const entries: EntryLike[] = [
		msg("e1", "user", "a"),
		{ id: "snap", type: "message", message: { role: "assistant", content: [] } },
	];
	assert.deepEqual(isPrefixLineageIntact(entries, "snap"), { ok: true });
});

for (const t of [
	"model_change",
	"thinking_level_change",
	"context_edit",
	"compaction",
	"branch_summary",
	"custom",
] as const) {
	test(`lineage: ${t} since the snapshot is drift`, () => {
		const entries: EntryLike[] = [
			{ id: "snap", type: "message", message: { role: "assistant", content: [] } },
			{ id: "x1", type: t },
			msg("e2", "user", "after"),
		];
		const v = isPrefixLineageIntact(entries, "snap");
		assert.equal(v.ok, false);
		if (!v.ok) assert.match(v.reason, new RegExp(t));
	});
}

test("lineage: snapshot leaf not on the branch (tree navigation) is not intact", () => {
	const entries: EntryLike[] = [msg("e1", "user", "a"), msg("e2", "assistant", "b")];
	const v = isPrefixLineageIntact(entries, "ghost");
	assert.equal(v.ok, false);
	if (!v.ok) assert.match(v.reason, /not on current branch/);
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

test("sumUsage: sums the nested cost object leaf-wise (pi 1.5.0 footer needs usage.cost.total)", () => {
	const u1 = {
		input: 100,
		output: 10,
		cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
	};
	const u2 = {
		input: 50,
		output: 5,
		cost: { input: 0.005, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.015 },
	};
	const out = sumUsage(u1, u2);
	assert.equal(out.input, 150);
	assert.equal(out.output, 15);
	assert.ok(out.cost, "cost object must survive the merge");
	assert.equal(out.cost?.total, 0.045);
	assert.equal(out.cost?.input, 0.015);
});

test("sumUsage: cost present on only one side is kept intact", () => {
	const out = sumUsage({ input: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } }, { input: 2 });
	assert.equal(out.input, 3);
	assert.deepEqual(out.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 });
});

test("sumUsage: adds like keys, keeps single-side keys", () => {
	assert.deepEqual(sumUsage({ input: 1, output: 2 }, { input: 3, cacheRead: 9 }), {
		input: 4,
		output: 2,
		cacheRead: 9,
	});
	assert.deepEqual(sumUsage(undefined, undefined), {});
});

test("truncate: caps and marks the cut", () => {
	const t = truncate("a".repeat(MAX_PULL_CHARS + 10), MAX_PULL_CHARS);
	assert.ok(t.startsWith("a".repeat(MAX_PULL_CHARS)));
	assert.match(t, /…\[truncated 10 chars — pull a narrower span\]/);
	assert.doesNotMatch(truncate("short", MAX_PULL_CHARS), /truncated/);
});
