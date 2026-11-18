#!/usr/bin/env node
/**
 * spill-anatomy.mjs — diagnose why the post-compaction prefill is large.
 *
 * Usage: node spill-anatomy.mjs <session-file.jsonl>
 *
 * For every compaction entry it prints:
 *   - the compaction doc size (and how many times it nests itself)
 *   - the kept-tail size (entries from firstKeptEntryId on)
 *   - the biggest individual tail messages
 *   - the next assistant turn's usage (input / cacheRead)
 *
 * Post-compaction prefill ≈ system+tools + doc + tail — everything is fresh
 * to the server after the prefix shape changes. If the prefill is still
 * "50%+ of the window", this shows which of the three parts is the culprit.
 */
import { readFileSync } from "node:fs";

const F = process.argv[2];
if (!F) {
	console.error("usage: node spill-anatomy.mjs <session-file.jsonl>");
	process.exit(2);
}

// resolve the globally installed pi (or pass an absolute path as argv[3])
import { homedir } from "node:os";
const HOME = homedir();
const PI_CANDIDATES = [
	process.argv[3],
	`file://${HOME}/.local/npm/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js`,
	`file://${HOME}/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js`,
].filter(Boolean);
let pi;
try {
	// works when run from inside a tree that has pi in node_modules
	pi = await import("@earendil-works/pi-coding-agent");
} catch {
	for (const c of PI_CANDIDATES) {
		try {
			pi = await import(c);
			break;
		} catch {
			// try next
		}
	}
}
if (!pi) {
	console.error("could not resolve @earendil-works/pi-coding-agent — pass its dist/index.js path as argv[3]");
	console.error("(find it with: npm root -g)");
	process.exit(3);
}
const { estimateTokens, sessionEntryToContextMessages } = pi;

const lines = readFileSync(F, "utf8").split("\n").filter(Boolean);
const entries = lines.map((l) => JSON.parse(l));

const comps = entries.filter((e) => e.type === "compaction");
console.log(`session: ${F}`);
console.log(`compactions: ${comps.length}\n`);

for (const c of comps) {
	const tier = c.details?.lazyCompact?.tier ?? "legacy";
	const doc = c.summary ?? "";
	const keepIdx = entries.findIndex((e) => e.id === c.firstKeptEntryId);
	const tail = keepIdx >= 0 ? entries.slice(keepIdx) : [];
	const tailMsgs = tail.flatMap((e) => (e.type === "message" ? sessionEntryToContextMessages(e) : []));
	let tailTok = 0;
	for (const m of tailMsgs) tailTok += estimateTokens(m);
	const docTok = estimateTokens({ role: "system", content: doc, timestamp: 0 });
	const nested = (doc.match(/# Session summary/g) || []).length;
	console.log(`--- ${c.timestamp}  [${tier}]  tokensBefore=${c.tokensBefore}`);
	console.log(`    doc: ${doc.length} chars ≈ ${docTok} tokens | nested headers: ${nested}${nested > 1 ? "  ← 0.3.0 nesting bug — upgrade to 0.3.1" : ""}`);
	console.log(`    tail: ${tail.length} entries ≈ ${tailTok} tokens`);
	const sized = tailMsgs
		.map((m) => ({ tok: estimateTokens(m), role: m.role }))
		.sort((a, b) => b.tok - a.tok)
		.slice(0, 5);
	console.log(`    biggest tail msgs: ${JSON.stringify(sized)}`);
	// next assistant usage
	const idx = entries.findIndex((e) => e.id === c.id);
	for (let i = idx + 1; i < entries.length && i < idx + 10; i++) {
		const e = entries[i];
		if (e.type === "message" && e.message?.role === "assistant" && e.message.usage) {
			const u = e.message.usage;
			const total = (u.input ?? 0) + (u.output ?? 0);
			console.log(
				`    next turn: input=${u.input} cacheRead=${u.cacheRead} output=${u.output}${total ? `  (total ≈ ${total})` : ""}`,
			);
			break;
		}
	}
	console.log("");
}
console.log("Post-compaction prefill ≈ system+tools + doc + tail (all fresh to the server).");
console.log("Levers: doc size (0.3.1 flattens it) · tail size (pi setting compaction.keepRecentTokens, default 20000).");
