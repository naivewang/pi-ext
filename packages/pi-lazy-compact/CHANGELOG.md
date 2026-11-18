# Changelog

## 0.3.1

- **Spill doc no longer nests.** 0.3.0 embedded the previous compaction doc verbatim under Head-ups, so each spill carried the whole previous doc (and the one before, …) — the doc grew without bound and the post-compaction prefill shrank only slowly. `buildSpillDoc` now flattens the previous doc (deterministic `parseSpillDoc`): innermost head-ups kept, every older region folded into one compact *Past regions* line (spans stay pullable), Archive carries only the current region. Doc size is bounded: constant head-ups + one small line per spill.
- Legacy LLM summaries are carried verbatim as the head-ups root — existing sessions migrate on their next spill.
- Section parser only treats the extension's own section titles as boundaries, so `## Goal`-style headings inside head-ups text are preserved.
- New diagnostic: `node scripts/spill-anatomy.mjs <session.jsonl>` — per compaction: doc size + nesting depth, kept-tail size, biggest tail messages, next turn's usage. Accounts for the post-compaction prefill (system+tools + doc + tail).
- Published as an installable npm package: `pi install npm:pi-lazy-compact`. Host-provided deps (`@earendil-works/pi-coding-agent`, `typebox`) declared as peers, not bundled.

## 0.3.0

- **Zero-LLM "context spill" compaction.** The `session_before_compact` handler performs no LLM call: the compaction document is built deterministically (previous summary as head-ups, deterministic region digest of files read/modified, pullable Archive index of entry-ID spans). Instant, cache-neutral, cannot 400 at the context ceiling.
- **Full-session dump on every spill** to `~/.pi/agent/lazy-compact/dumps/<sessionId>-<ts>.md` (keeps 10 newest). The spilled region is re-readable from three channels named in the doc: `history_pull` spans, the dump file, the raw session file.
- **Fail-closed.** Any failure writes `panic-<ts>.log` (error + full transcript), notifies the user to start a fresh session and salvage from the dump, and cancels the compaction. Deliberately **no fallback to legacy LLM compaction**. The only other exit is a user abort (clean cancel).
- `history_pull` remains the single pinned protocol tool; the hot/cold LLM path and `compact_ack` are retired.

## 0.2.10 and earlier (retired design)

Hot postfix summary (`compact_ack` contract, dual-contract marker, ceiling-aware
sizing, disk-persisted snapshots, fail-closed ladder with legacy fallback).
Recoverable from the v0.2.9 FTP tarball if ever wanted.
