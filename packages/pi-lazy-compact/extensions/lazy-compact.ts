/**
 * lazy-compact — context-spill compaction + lazy re-read for pi.
 *
 * WHY: pi's default compaction costs TWO full fresh prefills (the summary
 * call + the post-compaction rebuild) and at the context ceiling can 400 on
 * its own. That design is INFERIOR and is strictly deprecated by this
 * extension.
 *
 * 0.3.0 design (user-directed): compaction IS the context spill.
 *
 *  SPILL — deterministic, ZERO LLM calls, ZERO prefills, instant. When pi
 *  fires session_before_compact this hook immediately returns a spill doc
 *  in place of the old region:
 *    - Head-ups: the previous compaction's summary (older history only)
 *    - Region digest: deterministic file ops of the spilled region
 *    - Archive: entry-ID spans covering the spilled region
 *  Nothing is lost: the raw messages stay in the session file, and the full
 *  session context is additionally spilled to a dump file.
 *
 *  RE-READ — on demand, and on failure. The agent re-reads spilled detail:
 *    1. `history_pull(from, to?)` — raw messages by Archive span; results
 *       are tail-appended tool results (append-only prefix → the next turn
 *       is a cache read plus exactly the pulled chunk)
 *    2. the spill dump file (full context, readable with the file tools)
 *    3. the raw session file
 *
 *  STRICT DEPRECATION — the hook ALWAYS produces the compaction (or a clean
 *  cancel on abort/error), so pi's default path never runs; a
 *  session_compact monitor alarms loudly if a legacy (fromExtension:false)
 *  compaction ever lands.
 *
 *  Retired in 0.3.0: the hot/cold LLM summarization path (v0.2.x —
 *  recoverable from the v0.2.9 tarball if ever wanted), the compact_ack
 *  protocol tool, and the live-call snapshot capture.
 *
 * Install:  pi install npm:@elvinw/pi-lazy-compact
 *   or copy/symlink this directory into ~/.pi/agent/extensions/ and /reload.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	convertToLlm,
	serializeConversation,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionToolContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
	MAX_PULL_CHARS,
	PULL_TOOL_NAME,
	buildArchiveIndex,
	buildSpillDoc,
	buildSpillDump,
	spanEndId,
	truncate,
	type EntryLike,
} from "./lazy-compact-core.ts";

// ---------------------------------------------------------------------------
// Entry helpers over pi's raw session entries
// ---------------------------------------------------------------------------

function entriesAsLike(entries: SessionEntry[]): EntryLike[] {
	return entries as unknown as EntryLike[];
}

/** Raw branch entries that a compaction at `firstKeptEntryId` would summarize. */
function summarizedRegion(entries: SessionEntry[], firstKeptEntryId: string): SessionEntry[] {
	const keepIdx = firstKeptEntryId
		? entries.findIndex((e) => e.id === firstKeptEntryId)
		: entries.length;
	const upper = keepIdx === -1 ? entries.length : keepIdx;
	let compactIdx = -1;
	for (let i = upper - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			compactIdx = i;
			break;
		}
	}
	return entries.slice(compactIdx + 1, upper);
}

/** pi's FileOperations (Sets) → JSON-friendly sorted arrays. */
function fileOpsToArrays(fileOps: {
	read?: Set<string>;
	written?: Set<string>;
	edited?: Set<string>;
}): { readFiles: string[]; modifiedFiles: string[] } {
	const read = new Set(fileOps.read ?? []);
	const modified = new Set([...(fileOps.written ?? []), ...(fileOps.edited ?? [])]);
	for (const f of modified) read.delete(f);
	return {
		readFiles: [...read].sort(),
		modifiedFiles: [...modified].sort(),
	};
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function lazyCompact(pi: ExtensionAPI) {
	// ---- Pinned protocol tool (registered once, never changed) ----
	//
	// Hand-written JSON schema: no runtime typebox import, so the extension
	// has zero dependencies beyond pi itself. The tool list is constant for
	// the life of the session → the tool template is a stable prefix.

	const pullParams = {
		$schema: "http://json-schema.org/draft-07/schema#",
		type: "object",
		properties: {
			from: {
				type: "string",
				description:
					"Start entry ID, exactly as listed in the compaction document's Archive section.",
			},
			to: {
				type: "string",
				description:
					"Optional end entry ID, inclusive. Defaults to the end of the span that starts at `from`.",
			},
		},
		required: ["from"],
		additionalProperties: false,
	} as unknown as TSchema;

	pi.registerTool({
		name: PULL_TOOL_NAME,
		label: "History Pull",
		description:
			"Pull up the raw archived conversation for a span of session entry IDs from the compaction document's Archive section. Read-only; the result is appended to the conversation as context.",
		promptSnippet:
			"history_pull: read raw archived conversation by entry-ID span (from the compaction document's Archive section)",
		promptGuidelines: [
			"Spilled (compacted) history is re-read, not remembered: when the compaction document's head-ups lack detail you need (exact error text, a command, a file state, a quote), call history_pull with the matching Archive span instead of guessing.",
		],
		parameters: pullParams,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) => {
			const p = params as { from: string; to?: string };
			const entries = ctx.sessionManager.getBranch();
			const i = entries.findIndex((e) => e.id === p.from);
			if (i < 0) {
				const region = entriesAsLike(summarizedRegion(entries, ""));
				const spans = buildArchiveIndex(region);
				const hint = spans.length
					? `Current archive spans: ${spans.map((a) => `${a.from}→${a.to}`).join(", ")}`
					: "No summarized archive on this branch.";
				return {
					content: [
						{
							type: "text",
							text: `No entry with id "${p.from}" on the current branch. ${hint} If the span comes from an old compaction document, re-read the spill dump file or the raw session file instead.`,
						},
					],
					details: { error: "not-found" },
				};
			}
			const toId = p.to ?? spanEndId(entriesAsLike(entries), p.from);
			const j = toId ? entries.findIndex((e) => e.id === toId) : i;
			if (j < i)
				return {
					content: [
						{
							type: "text",
							text: `history_pull: "to" (${toId}) must be at or after "from" (${p.from}).`,
						},
					],
					details: { error: "bad-span" },
				};
			const slice = entries.slice(i, j + 1);
			const messages = slice.flatMap((e) =>
				e.type === "message" ? sessionEntryToContextMessages(e) : [],
			);
			const text = serializeConversation(convertToLlm(messages));
			return {
				content: [
					{
						type: "text",
						text: truncate(text || "(no message content in span)", MAX_PULL_CHARS),
					},
				],
				details: { from: p.from, to: toId ?? p.from, chars: text.length },
			};
		},
	});

	// ---- Compaction = CONTEXT SPILL (deterministic, zero LLM, zero prefill) ----

	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, signal } = event;
		const notify = (text: string, level: "info" | "warning" = "info") => {
			try {
				ctx.ui.notify(`lazy-compact: ${text}`, level);
			} catch {
				// headless mode: no UI
			}
		};

		// Abort (your escape) stays a clean cancel.
		if (signal.aborted) {
			notify("compaction aborted — clean cancel", "info");
			return { cancel: true };
		}

		try {
			const branch = ctx.sessionManager.getBranch();
			const sessionId = ctx.sessionManager.getSessionId();
			const sessionFile = ctx.sessionManager.getSessionFile();
			const archive = buildArchiveIndex(
				entriesAsLike(summarizedRegion(branch, preparation.firstKeptEntryId)),
			);
			const { readFiles, modifiedFiles } = fileOpsToArrays(preparation.fileOps);

			// Spill dump: the FULL session context to disk — the definitive
			// re-read source (and a seed for a fresh session if ever wanted).
			let dumpPath: string | undefined;
			try {
				const dir = join(homedir(), ".pi", "agent", "lazy-compact", "dumps");
				mkdirSync(dir, { recursive: true });
				const projection = ctx.sessionManager.buildSessionProjection();
				const doc = buildSpillDump({
					sessionId,
					sessionFile,
					modelId: ctx.model?.id,
					tokensBefore: preparation.tokensBefore,
					previousSummary: preparation.previousSummary,
					archive,
					transcript: serializeConversation(
						convertToLlm(projection.messages) as unknown as Parameters<typeof serializeConversation>[0],
					),
				});
				dumpPath = join(dir, `${sessionId}-${Date.now()}.md`);
				writeFileSync(dumpPath, doc);
			} catch {
				// dump is a re-read convenience; the session file remains intact
			}

			const summary = buildSpillDoc({
				previousDoc: preparation.previousSummary,
				archive,
				tokensBefore: preparation.tokensBefore,
				dumpPath,
				sessionFile,
				readFiles,
				modifiedFiles,
			});

			notify(
				`context spill — ${archive.length} spans, ~${preparation.tokensBefore} tokens spilled (no LLM call); session continues; re-read via ${PULL_TOOL_NAME}${dumpPath ? ` or ${dumpPath}` : ""}`,
				"info",
			);
			return {
				compaction: {
					summary,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					details: {
						readFiles,
						modifiedFiles,
						lazyCompact: { tier: "spill", dump: dumpPath ?? null },
					},
				},
			};
		} catch (err) {
			// Even if the spill machinery itself throws: never degrade to the
			// deprecated default compaction — leave the session intact.
			notify(
				`spill failed — cancelling compaction (session left intact; the default compaction is deprecated and was NOT used): ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
			return { cancel: true };
		}
	});

	// ---- Strict-deprecation monitor ----
	//
	// pi emits session_compact after EVERY compaction with fromExtension set.
	// If a legacy (default) compaction ever lands, the inferior path ran
	// (extension not loaded, or hook not registered) — alarm loudly.
	pi.on("session_compact", (event, ctx) => {
		const e = event as { fromExtension?: boolean };
		if (e.fromExtension === false) {
			try {
				ctx.ui.notify(
					"lazy-compact: ⚠️ DEFAULT COMPACTION RAN — the deprecated legacy path (full prefill) produced this compaction; the lazy-compact hook did not produce it. Check that the extension is loaded and /reload.",
					"warning",
				);
			} catch {
				// headless mode: no UI
			}
		}
	});
}
