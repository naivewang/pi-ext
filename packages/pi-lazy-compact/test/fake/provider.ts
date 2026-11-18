/**
 * Fake LLM + prefix-cache oracle.
 *
 * No network, no model: every "request" is a {system, messages} prompt that
 * we serialize to a canonical string and measure against a simulated provider
 * prefix cache:
 *
 *   - the cache holds the full serialized prompt of every prior request that
 *     did not disable caching (cacheRetention !== "none");
 *   - a request's cacheRead = length of the longest cached prompt that is a
 *     string prefix of this request; freshInput = the rest (the "prefill");
 *   - a request with cacheRetention "none" reads the cache but writes nothing
 *     (pi's one-off-prompt mode, used by today's compaction summary calls).
 *
 * Char counts stand in for tokens (1:1). The proofs are structural — "does
 * request N+1 start with request N?" — so exact tokenization is irrelevant.
 *
 * Intentionally NOT modeled: cache TTL/expiry, sub-message cache breakpoints
 * (a real provider may credit a partial hit up to the last breakpoint before
 * the divergence point; the sim only credits whole-prompt prefixes, so it
 * UNDER-credits partial hits — the proofs stay valid, the measured savings
 * are conservative), pricing tiers, parallel slots.
 */

import type { Message } from "./session.ts";

export interface Prompt {
	system: string;
	/**
	 * Tool definitions (opaque blobs here). Serialized BETWEEN system and
	 * messages — exactly where real providers put them: inside the cache-key
	 * prefix. A tool-list change therefore busts the cache like any mid-prompt
	 * edit.
	 */
	tools?: string[];
	messages: Message[];
}

export function serializeMessage(m: Message): string {
	let s = `[${m.role}]`;
	if (m.toolName) s += ` toolCall=${m.toolName}(${JSON.stringify(m.toolArgs)})`;
	if (m.tool) s += ` (result of ${m.tool})`;
	return `${s}\n${m.content}`;
}

export function serializePrompt(p: Prompt): string {
	const tools = (p.tools ?? []).join("\n");
	const msgs = p.messages.map(serializeMessage).join("\n");
	return `<<system>>\n${p.system}\n<<tools>>\n${tools}\n<<messages>>\n${msgs}`;
}

export interface RequestRecord {
	index: number;
	label: string;
	prompt: Prompt;
	serialized: string;
	/** chars served from the simulated prefix cache */
	cacheRead: number;
	/** chars prefilled fresh (serialized.length - cacheRead) */
	freshInput: number;
	/** true if this prompt strictly extends the previous request's prompt */
	extendsPrevious: boolean;
	response: string;
}

export interface CompleteOptions {
	/** "none" = read the cache but write nothing (pi: one-off prompts) */
	cacheRetention?: "none" | "short";
	/** canned model response (scripted — there is no model) */
	response?: string;
}

export class FakeProvider {
	requests: RequestRecord[] = [];
	private cachedPrompts: string[] = [];
	private prevSerialized: string | null = null;

	complete(label: string, prompt: Prompt, opts: CompleteOptions = {}): RequestRecord {
		const serialized = serializePrompt(prompt);
		let cacheRead = 0;
		for (const c of this.cachedPrompts) {
			if (serialized.startsWith(c) && c.length > cacheRead) cacheRead = c.length;
		}
		const rec: RequestRecord = {
			index: this.requests.length,
			label,
			prompt,
			serialized,
			cacheRead,
			freshInput: serialized.length - cacheRead,
			extendsPrevious: this.prevSerialized !== null && serialized.startsWith(this.prevSerialized),
			response: opts.response ?? "",
		};
		this.requests.push(rec);
		if (opts.cacheRetention !== "none") this.cachedPrompts.push(serialized);
		this.prevSerialized = serialized;
		return rec;
	}

	/** Assert requests [from..to) form a strict prefix chain (append-only prompt). */
	assertPrefixChain(from = 0, what: string, to = this.requests.length): void {
		for (let i = from + 1; i < to; i++) {
			if (!this.requests[i].extendsPrevious) {
				throw new Error(
					`${what}: request #${i} (${this.requests[i].label}) does not extend request #${i - 1} (${this.requests[i - 1].label})`,
				);
			}
		}
	}

	/** Human-readable cost table (chars ~= tokens). */
	report(): string {
		return this.requests
			.map(
				(r) =>
					`  #${r.index} ${r.label.padEnd(24)} total=${String(r.serialized.length).padStart(7)} ` +
					`cacheRead=${String(r.cacheRead).padStart(7)} fresh=${String(r.freshInput).padStart(7)} ` +
					`extendsPrev=${r.extendsPrevious}`,
			)
			.join("\n");
	}
}
