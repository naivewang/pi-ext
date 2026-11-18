/**
 * lazy-compact-core — pure logic for the lazy-compact pi extension.
 *
 * No pi imports: this file is unit-testable with plain fixtures (test/part-d).
 * The extension (lazy-compact.ts) wires these functions to pi's API.
 */

// ---------------------------------------------------------------------------
// Structural mirrors of pi/pi-ai types (kept local so tests need no deps).
// ---------------------------------------------------------------------------

export interface AckContentItem {
	type: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

export interface AckResponse {
	stopReason: string;
	content: AckContentItem[];
	errorMessage?: string;
}

export interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	/** pi-ai usage carries a nested cost object — keep it intact. */
	cost?: { [k: string]: number | boolean | undefined };
	[k: string]: unknown;
}

export interface EntryLike {
	id: string;
	type?: string;
	message?: { role?: string; content?: unknown } | string;
	[k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export const MIN_SUMMARY_CHARS = 80;
export const MAX_SUMMARY_CHARS = 24_000;
export const MAX_PULL_CHARS = 12_000;
export const ACK_TOOL_NAME = "compact_ack";
export const PULL_TOOL_NAME = "history_pull";
/**
 * Text-form fallback for models that ignore the tool contract: a summary
 * wrapped in these markers is accepted when no compact_ack call is present.
 * Keeps validation deterministic for weaker models.
 */
export const SUMMARY_OPEN = "<compaction_summary>";
export const SUMMARY_CLOSE = "</compaction_summary>";

// ---------------------------------------------------------------------------
// Ack validation (the protocol contract)
// ---------------------------------------------------------------------------

export type AckVerdict =
	| { ok: true; summary: string; truncated?: boolean }
	| { ok: false; reason: string; offenderText: string };


export function extractAck(resp: AckResponse | undefined): AckVerdict {
	if (!resp) return { ok: false, reason: "no response", offenderText: "" };
	if (resp.errorMessage)
		return { ok: false, reason: `provider error: ${resp.errorMessage}`, offenderText: "" };
	const text = resp.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n")
		.trim();
	const call = resp.content.find((c) => c.type === "toolCall" && c.name === ACK_TOOL_NAME);
	if (call) {
		const summary =
			typeof call.arguments?.summary === "string" ? (call.arguments.summary as string).trim() : "";
		if (summary.length < MIN_SUMMARY_CHARS)
			return {
				ok: false,
				reason: `compact_ack summary too short (${summary.length} < ${MIN_SUMMARY_CHARS} chars)`,
				offenderText: summary,
			};
		return { ok: true, summary: summary.slice(0, MAX_SUMMARY_CHARS) };
	}
	// Text fallback (dual contract): a well-formed marker block counts as
	// compliance for models that won't make the tool call.
	const i = text.indexOf(SUMMARY_OPEN);
	if (i >= 0) {
		const j = text.lastIndexOf(SUMMARY_CLOSE);
		const closed = j > i;
		const content = text.slice(i + SUMMARY_OPEN.length, closed ? j : undefined).trim();
		if (content.length < MIN_SUMMARY_CHARS)
			return {
				ok: false,
				reason: `marked summary too short (${content.length} < ${MIN_SUMMARY_CHARS} chars)`,
				offenderText: content,
			};
		if (closed) return { ok: true, summary: content.slice(0, MAX_SUMMARY_CHARS) };
		// Unclosed marker: accept only when the provider clipped the output
		// (stopReason "length"). The content is definitely a summary, just
		// cut short — better than a retry that 400s and a full-prefill
		// legacy fallback.
		if (resp.stopReason === "length")
			return { ok: true, summary: content.slice(0, MAX_SUMMARY_CHARS), truncated: true };
		return {
			ok: false,
			reason: `summary opened ${SUMMARY_OPEN} but never closed it`,
			offenderText: content,
		};
	}
	const reason =
		resp.stopReason === "toolUse"
			? "called a tool other than compact_ack and no marked summary"
			: `no compact_ack call and no ${SUMMARY_OPEN} … ${SUMMARY_CLOSE} block`;
	return { ok: false, reason, offenderText: text };
}

// ---------------------------------------------------------------------------
// Protocol messages (postfix instruction + retry)
// ---------------------------------------------------------------------------

export function makeInstruction(customInstructions?: string): string {
	const custom = customInstructions
		? `\nUser instructions for this compaction: ${customInstructions}\n`
		: "";
	return `STOP. STOP. STOP.
This is NOT a user message. This is a system instruction.

The session is being compacted NOW. You must generate the compaction summary NOW, in this turn.

Do exactly ONE of these, in order of preference:
1. Call the \`${ACK_TOOL_NAME}\` tool and FILL its \`summary\` argument with the full summary text (never leave it empty or a placeholder).
2. If you cannot call tools, reply with ONLY this (nothing else, no prose around it):
${SUMMARY_OPEN}
<the summary>
${SUMMARY_CLOSE}

The summary is structured markdown covering: original goal(s) and constraints; progress with key file/code facts; key decisions and their rationale; current state of any work in progress; blockers and open questions; next steps.${custom}
Do NOT continue the conversation. Do NOT answer the last user message. Do NOT start new work.
GENERATE THE COMPACTION SUMMARY NOW.`;
}


export function makeRetrial(reason: string, offenderText: string): string {
	const offender = offenderText
		? `\nYour last response was:\n---\n${offenderText.slice(0, 500)}\n---\n`
		: "";
	return `STOP. You did not comply: ${reason}.${offender}
Generate the compaction NOW. Do exactly ONE of these, nothing else:
1. Call the \`${ACK_TOOL_NAME}\` tool and FILL its \`summary\` argument with the full summary text.
2. Reply with ONLY ${SUMMARY_OPEN} <the summary> ${SUMMARY_CLOSE}.
Do NOT continue the conversation. Do NOT answer the last user message. GENERATE THE COMPACTION NOW.`;
}

// ---------------------------------------------------------------------------
// Archive index (deterministic spans, no model work)
// ---------------------------------------------------------------------------

export interface ArchiveLine {
	from: string;
	to: string;
	label: string;
	entries: number;
}

/** First text of a session message's content (string or content-block array). */
export function entryText(message: EntryLike["message"]): string {
	if (message == null) return "";
	if (typeof message === "string") return message;
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		for (const part of content) {
			if (
				part &&
				typeof part === "object" &&
				(part as { type?: string }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string"
			)
				return (part as { text: string }).text;
		}
	}
	return "";
}

function isMessageEntry(e: EntryLike): boolean {
	return e.type === "message" && !!e.message && typeof e.message !== "string";
}

function roleOf(e: EntryLike): string | undefined {
	if (!isMessageEntry(e)) return undefined;
	return (e.message as { role?: string }).role;
}

/**
 * Group raw branch entries into user-message spans: a span starts at each user
 * message and runs until the entry before the next user message. These become
 * the Archive lines in the compaction document and the default pull-up spans.
 */
export function buildArchiveIndex(entries: EntryLike[]): ArchiveLine[] {
	const lines: ArchiveLine[] = [];
	let start: EntryLike | undefined;
	let count = 0;
	let prev: EntryLike | undefined;
	const flush = (end: EntryLike) => {
		if (start)
			lines.push({
				from: start.id,
				to: end.id,
				label: entryText(start.message).slice(0, 100),
				entries: count,
			});
		start = undefined;
		count = 0;
	};
	for (const e of entries) {
		const role = roleOf(e);
		if (role === "user") {
			if (start) flush(prev ?? start);
			start = e;
			count = 1;
		} else if (role === "assistant" || role === "toolResult") {
			if (start) count++;
			else {
				// Leading entries before the first user message: fold into a synthetic span.
				start = e;
				count = 1;
			}
		}
		prev = e;
	}
	if (start) flush(prev ?? start);
	return lines;
}

/**
 * End of the span that starts at entry `fromId`: the entry just before the next
 * user message, or the end of the branch. Used as `history_pull`'s default `to`.
 */
/**
 * Entry types that mutate the provider request (prompt, tools, model, or
 * context bytes). Anything else between the snapshot leaf and the current
 * leaf is a pure append (or metadata) and keeps the prefix lineage intact.
 */
export const DRIFT_ENTRY_TYPES: ReadonlySet<string> = new Set([
	"model_change",
	"thinking_level_change",
	"context_edit",
	"compaction",
	"branch_summary",
	"custom",
]);

/**
 * Leading system message for the cold-start hot path: used when compaction
 * fires before any live LLM call in this process (resume/fork of an
 * already-large session, overflow recovery at startup). There is no captured
 * live system message to replay, so we synthesize one with the rendered
 * prompt and ONLY the compact_ack declaration — the summary call needs no
 * other tools. Costs one full fresh prefill (legacy-equivalent) but keeps
 * the ack contract and the two-tier document.
 */
/**
 * Validate/parse a persisted snapshot (see the extension's disk restore).
 * The snapshot survives pi restarts and /reload; the llama.cpp (or any
 * long-lived server's) KV cache outlives the pi process, so a restored
 * snapshot can still ride a warm prefix.
 */
export function restoreSnapshotJson(
	json: string,
): { system: Record<string, unknown>; leafId: string } | undefined {
	try {
		const data = JSON.parse(json) as {
			system?: { role?: string } & Record<string, unknown>;
			leafId?: unknown;
		};
		if (
			data &&
			typeof data === "object" &&
			data.system &&
			typeof data.system === "object" &&
			data.system.role === "system" &&
			typeof data.leafId === "string" &&
			data.leafId.length > 0
		) {
			return { system: data.system, leafId: data.leafId };
		}
	} catch {
		// malformed file → treat as absent
	}
	return undefined;
}

export function buildColdSystemMessage(
	systemPrompt: string,
	ackTool: { name: string; description: string; parameters: unknown },
): Record<string, unknown> {
	return {
		role: "system",
		content: systemPrompt,
		toolsAdded: [ackTool],
		timestamp: 0,
	};
}

export type LineageVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Is the current branch a pure append after `snapshotLeafId`? True when every
 * entry since the snapshot is message/metadata that lands AFTER the snapshot
 * point (so the replayed prefix is unchanged); false when a drift entry
 * appears, or the snapshot leaf is not on the current branch at all.
 */
export function isPrefixLineageIntact(entries: EntryLike[], snapshotLeafId: string): LineageVerdict {
	const i = entries.findIndex((e) => e.id === snapshotLeafId);
	if (i < 0) return { ok: false, reason: "snapshot leaf not on current branch (tree navigation?)" };
	for (let j = i + 1; j < entries.length; j++) {
		const t = entries[j].type ?? "";
		if (DRIFT_ENTRY_TYPES.has(t))
			return { ok: false, reason: `drift entry since last live call: ${t}` };
	}
	return { ok: true };
}

export function spanEndId(entries: EntryLike[], fromId: string): string | undefined {
	const i = entries.findIndex((e) => e.id === fromId);
	if (i < 0) return undefined;
	for (let j = i + 1; j < entries.length; j++) {
		if (roleOf(entries[j]) === "user") return entries[j - 1].id;
	}
	return entries[entries.length - 1]?.id;
}

// ---------------------------------------------------------------------------
// Compaction document (two-tier: head-ups + archive)
// ---------------------------------------------------------------------------

export function buildCompactionDoc(summary: string, archive: ArchiveLine[], tokensBefore: number): string {
	const lines = archive
		.map((a) => `- [${a.from} → ${a.to}] "${a.label || "(no user text)"}" (${a.entries} entries)`)
		.join("\n");
	const archiveSection = archive.length
		? `\n## Archive\n\nThe raw messages above the kept tail were ARCHIVED, not summarized away. When you need detail that the head-ups do not contain (exact error text, a command, a file state, a quote), pull it up with the \`${PULL_TOOL_NAME}\` tool using an entry-ID span from the list below (e.g. \`from: "${archive[0].from}"\`). Pulls are read-only context; do not restate pulled content in your replies.\n\n${lines}\n`
		: "";
	return `# Session summary (lazy-compact)

## Head-ups

${summary}
${archiveSection}
~${tokensBefore} tokens were compacted into this document.`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sumLeaves(x?: Record<string, unknown>, y?: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const keys = new Set([...Object.keys(x ?? {}), ...Object.keys(y ?? {})]);
	for (const k of keys) {
		const a = x?.[k];
		const b = y?.[k];
		if (typeof a === "number" || typeof b === "number")
			out[k] = ((a as number | undefined) ?? 0) + ((b as number | undefined) ?? 0);
		else if (a !== undefined || b !== undefined) out[k] = a ?? b;
	}
	return out;
}

export function sumUsage(a?: UsageLike, b?: UsageLike): UsageLike {
	if (!a && !b) return {};
	// Top-level token counts are summed; the nested cost object (present in
	// pi-ai usage) is merged leaf-wise — dropping it would break pi's
	// session-stat consumers (e.g. the 1.5.0 footer reads usage.cost.total).
	const out: UsageLike = sumLeaves(
		a as Record<string, unknown>,
		b as Record<string, unknown>,
	) as UsageLike;
	if (a?.cost || b?.cost)
		out.cost = sumLeaves(
			a?.cost as Record<string, unknown> | undefined,
			b?.cost as Record<string, unknown> | undefined,
		) as UsageLike["cost"];
	return out;
}

export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return (
		text.slice(0, max) +
		`\n…[truncated ${text.length - max} chars — pull a narrower span]`
	);
}

// ---------------------------------------------------------------------------
// Context spill dump (0.3.0): written on EVERY compaction — the full
// session context on disk. The definitive re-read source and a seed for a
// fresh session if ever wanted.
// ---------------------------------------------------------------------------

export interface SpillDumpOptions {
	sessionId: string;
	sessionFile?: string;
	modelId?: string;
	tokensBefore?: number;
	previousSummary?: string;
	archive: ArchiveLine[];
	/** Serialized current session projection (compaction-aware full context). */
	transcript: string;
	timestamp?: string;
}

export function buildSpillDump(o: SpillDumpOptions): string {
	const archiveLines = o.archive
		.map((a) => `- [${a.from} → ${a.to}] "${a.label || "(no user text)"}" (${a.entries} entries)`)
		.join("\n");
	const sections: string[] = [];
	sections.push("# lazy-compact context spill dump");
	sections.push("");
	sections.push(`- session: ${o.sessionId}`);
	if (o.sessionFile) sections.push(`- session file: ${o.sessionFile}`);
	if (o.modelId) sections.push(`- model: ${o.modelId}`);
	if (o.tokensBefore !== undefined) sections.push(`- tokensBefore: ~${o.tokensBefore}`);
	sections.push(`- timestamp: ${o.timestamp ?? new Date().toISOString()}`);
	sections.push("");
	sections.push("## How to re-read");
	sections.push("");
	sections.push(
		[
			"The session CONTINUES — the compaction was a deterministic context spill",
			"(no LLM call, nothing summarized away). This file is the complete",
			"re-read source: the transcript below is the full compaction-aware",
			"session context — previous compaction summaries included. Feed it (or",
			"its relevant sections) to a new session if you ever want to start",
			"fresh. Everything else (raw entries, other branches) remains in the",
			"session file referenced above.",
		].join("\n"),
	);
	if (o.previousSummary) {
		sections.push("");
		sections.push("## Previous compaction summary (already-condensed history)");
		sections.push("");
		sections.push(o.previousSummary);
	}
	if (o.archive.length) {
		sections.push("");
		sections.push("## Archive index (spans of the spilled region)");
		sections.push("");
		sections.push(archiveLines);
	}
	sections.push("");
	sections.push("## Full current session context");
	sections.push("");
	sections.push(o.transcript);
	return sections.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Spill doc parsing (0.3.1): deterministic, lenient parser for OUR doc
// format. Used to FLATTEN the previous doc: keep only the innermost
// head-ups and fold every archived region into one compact "past region"
// line. 0.3.0 embedded the previous doc verbatim → the doc nested itself
// without bound (each spill carried the whole previous doc, which carried
// the one before, …). Flattening makes doc size bounded: constant head-ups
// + one small line per spill + the current region's archive.
// ---------------------------------------------------------------------------

export interface SpillDocParse {
	isSpill: boolean;
	/** Innermost head-ups content (the true condensed history). */
	headups?: string;
	/** Existing compact past-region lines (new-format docs). */
	pastRegionLines: string[];
	/** One entry per "## Archive" section, oldest→newest (nested docs). */
	regions: { spans: string[]; tokens?: number }[];
	/** Non-spill (legacy LLM) summary: the whole doc. */
	legacySummary?: string;
}

export function parseSpillDoc(doc: string): SpillDocParse {
	const isSpill = doc.includes("# Session summary (lazy-compact — context spill)");
	if (!isSpill) {
		return { isSpill: false, pastRegionLines: [], regions: [], legacySummary: doc };
	}
	const lines = doc.split("\n");
	// Section boundaries are ONLY our own titles — head-ups text may contain
	// arbitrary "## " headings (legacy LLM summaries do: "## Goal", …).
	const KNOWN = ["## Head-ups", "## Region digest", "## Past regions", "## Archive"];
	const secIdx: number[] = [];
	for (let i = 0; i < lines.length; i++)
		if (KNOWN.some((k) => lines[i].startsWith(k))) secIdx.push(i);
	const secContent = (k: number): string[] =>
		lines.slice(secIdx[k] + 1, k + 1 < secIdx.length ? secIdx[k + 1] : lines.length);
	const lastSection = (prefix: string): string[] | undefined => {
		for (let k = secIdx.length - 1; k >= 0; k--)
			if (lines[secIdx[k]].startsWith(prefix)) return secContent(k);
		return undefined;
	};
	const headupsSec = lastSection("## Head-ups");
	const pastSec = lastSection("## Past regions");
	// All "## Archive" sections, text order (= oldest→newest for nested docs),
	// zipped with the "~N tokens were spilled" lines (same order).
	const tokMatches = [...doc.matchAll(/~(\d+) tokens were spilled/g)].map((m) =>
		parseInt(m[1], 10),
	);
	const regions: { spans: string[]; tokens?: number }[] = [];
	let t = 0;
	for (let k = 0; k < secIdx.length; k++) {
		if (!lines[secIdx[k]].startsWith("## Archive")) continue;
		const spans = secContent(k)
			.map((l) => l.match(/^- \[([^\]]+) → ([^\]]+)\]/))
			.filter((m): m is RegExpMatchArray => !!m)
			.map((m) => `${m[1]}→${m[2]}`);
		regions.push({ spans, tokens: tokMatches[t] !== undefined ? tokMatches[t++] : undefined });
	}
	return {
		isSpill: true,
		headups: headupsSec?.join("\n").trim() || undefined,
		pastRegionLines: pastSec?.filter((l) => l.startsWith("- ")) ?? [],
		regions,
	};
}

// ---------------------------------------------------------------------------
// Context spill doc (0.3.1): the compaction document itself. Deterministic,
// zero LLM, bounded size: the previous doc is FLATTENED (innermost head-ups
// + one compact line per older region), never embedded verbatim.
// ---------------------------------------------------------------------------

export interface SpillDocOptions {
	/** The previous compaction doc (any format) — flattened, never embedded. */
	previousDoc?: string;
	archive: ArchiveLine[];
	tokensBefore: number;
	dumpPath?: string;
	sessionFile?: string;
	readFiles?: string[];
	modifiedFiles?: string[];
}

const FIRST_SPILL_HEADUPS =
	"No previous summary exists — this is the first spill, so there is no condensed older history. The Archive below is the only record of the spilled region.";

export function buildSpillDoc(o: SpillDocOptions): string {
	const lines = o.archive
		.map((a) => `- [${a.from} → ${a.to}] "${a.label || "(no user text)"}" (${a.entries} entries)`)
		.join("\n");

	// ---- flatten the previous doc (bounded growth) ----
	let headups: string;
	let pastRegionLines: string[] = [];
	if (o.previousDoc?.trim()) {
		const prev = parseSpillDoc(o.previousDoc);
		if (prev.isSpill) {
			headups = prev.headups || FIRST_SPILL_HEADUPS;
			pastRegionLines = [...prev.pastRegionLines];
			for (const r of prev.regions) {
				pastRegionLines.push(
					r.tokens !== undefined
						? `- ~${r.tokens} tokens spilled: ${r.spans.join(", ") || "(no spans)"}`
						: `- region spilled: ${r.spans.join(", ") || "(no spans)"}`,
				);
			}
		} else {
			// Legacy (LLM) summary: bounded by the model's own output —
			// carry it verbatim as the head-ups, start fresh past-regions.
			headups = prev.legacySummary!.trim() || FIRST_SPILL_HEADUPS;
		}
	} else {
		headups = FIRST_SPILL_HEADUPS;
	}

	const first = o.archive[0];
	const reRead: string[] = [
		`1. \`${PULL_TOOL_NAME}(from, to?)\` with a span from the Archive below or a Past regions line${first ? ` (e.g. \`from: "${first.from}"\`)` : ""}`,
	];
	let n = 2;
	if (o.dumpPath) reRead.push(`${n++}. Full spill dump: ${o.dumpPath} (complete session context — read it with your file tools)`);
	if (o.sessionFile) reRead.push(`${n++}. Raw session file: ${o.sessionFile}`);
	const digest: string[] = [];
	if (o.readFiles?.length) digest.push(`- read: ${o.readFiles.join(", ")}`);
	if (o.modifiedFiles?.length) digest.push(`- modified: ${o.modifiedFiles.join(", ")}`);
	const digestSection = digest.length ? `\n## Region digest (deterministic)\n\n${digest.join("\n")}\n` : "";
	const pastSection = pastRegionLines.length
		? `\n## Past regions (already spilled — spans still pullable)\n\n${pastRegionLines.join("\n")}\n`
		: "";
	return `# Session summary (lazy-compact — context spill)

Older history was SPILLED, not summarized (no LLM call — zero loss: the raw messages remain in the session file). Do not assume you remember the spilled region — re-read what you need:
${reRead.join("\n")}
${digestSection}${pastSection}
## Head-ups (condensed older history)

${headups}

## Archive (the region spilled now — pull up with ${PULL_TOOL_NAME})

${lines || "(no archive spans — the region had no user-message spans)"}

~${o.tokensBefore} tokens were spilled into this document.`;
}
