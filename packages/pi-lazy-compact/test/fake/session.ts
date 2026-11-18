/**
 * Fake pi session — the minimal slice of pi's session model this lab needs:
 * an append-only linear entry list with compaction-aware projection, mirroring
 * what dist/core/session-manager.js does (newest compaction wins; model
 * context = [summary] + messages from firstKeptEntryId onward).
 *
 * Deliberately NOT modeled: branches/tree, labels, context_edit omissions,
 * split-turn handling. None of them affect the prefix proofs.
 */

export type Role = "user" | "assistant" | "toolResult";

export interface Message {
	role: Role;
	content: string;
	/** assistant messages that call a tool */
	toolName?: string;
	toolArgs?: unknown;
	/** toolResult: which tool produced it */
	tool?: string;
}

export interface MessageEntry {
	id: string;
	type: "message";
	message: Message;
}

/** Mirrors pi's CompactionEntry (subset). */
export interface CompactionEntry {
	id: string;
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
}

export type Entry = MessageEntry | CompactionEntry;

export class FakeSession {
	entries: Entry[] = [];
	private n = 0;

	private nextId(): string {
		return `e${++this.n}`;
	}

	addMessage(message: Message): MessageEntry {
		const e: MessageEntry = { id: this.nextId(), type: "message", message };
		this.entries.push(e);
		return e;
	}

	addCompaction(summary: string, firstKeptEntryId: string): CompactionEntry {
		const e: CompactionEntry = {
			id: this.nextId(),
			type: "compaction",
			summary,
			firstKeptEntryId,
			tokensBefore: this.entries.length, // not used by the proofs
		};
		this.entries.push(e);
		return e;
	}

	/** pi: only the newest compaction on the path is live. */
	latestCompaction(): CompactionEntry | null {
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const e = this.entries[i];
			if (e.type === "compaction") return e;
		}
		return null;
	}

	messageEntries(): MessageEntry[] {
		return this.entries.filter((e): e is MessageEntry => e.type === "message");
	}

	/**
	 * The compaction-aware model context (pi: buildContextEntries +
	 * projectContextEntry). No compaction: every message. With compaction:
	 * the summary rendered as a user message FIRST, then the messages from
	 * firstKeptEntryId onward. Older summarized messages are dropped.
	 */
	projectContext(): Message[] {
		const c = this.latestCompaction();
		if (!c) return this.messageEntries().map((e) => e.message);
		const idx = this.entries.findIndex((e) => e.id === c.firstKeptEntryId);
		const kept = this.entries
			.slice(idx >= 0 ? idx : 0)
			.filter((e): e is MessageEntry => e.type === "message")
			.map((e) => e.message);
		return [{ role: "user", content: c.summary }, ...kept];
	}
}
