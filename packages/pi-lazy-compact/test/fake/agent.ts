/**
 * Shared scenario: a session grown the way a long autonomous pi run grows —
 * one user task, then rounds of (request -> assistant tool call -> tool
 * result), ending with a text answer. All agent behavior is scripted; the
 * only thing being measured is what each request's prompt looks like.
 */

import { FakeSession, type Message } from "./session.ts";
import { FakeProvider, type RequestRecord } from "./provider.ts";

export const SYSTEM = "You are pi, a coding agent. Use tools to accomplish the task.";

/** Steady-state toolset (opaque definition blobs — identity/stability is what matters). */
export const BASE_TOOLS = ["bash(command: string)", "read(path: string)", "edit(path: string, edits: unknown)"];
/** Part A: must be pre-registered on EVERY live request (the summary request must stay a prefix extension). */
export const COMPACT_ACK_TOOL = "compact_ack(summary: string)";
/** Part B: stable pipe — takes ANY entry-ID span; the table of valid entries lives in the document, not here. */
export const HISTORY_PULL_TOOL = "history_pull(from: entryId, to?: entryId)";

/** ~400 chars of deterministic tool output, so the context has real mass. */
export function fakeOutput(i: number): string {
	const line = `build step ${i}: compiling module-${i} ... OK (2 warnings, 0 errors)\n`;
	return line.repeat(24); // ~1.7k chars per tool result
}

export interface Scenario {
	session: FakeSession;
	provider: FakeProvider;
	system: string;
	/** the live agent requests, in order (a prefix chain) */
	live: RequestRecord[];
}

export function makeGrownScenario(rounds = 4, tools: string[] = BASE_TOOLS): Scenario {
	const session = new FakeSession();
	const provider = new FakeProvider();
	const system = SYSTEM;
	const live: RequestRecord[] = [];

	session.addMessage({ role: "user", content: "build the retry pipeline for the scheduler" });
	for (let i = 0; i < rounds; i++) {
		live.push(
			provider.complete(`live r${i}`, { system, tools, messages: session.projectContext() }, { response: `step ${i}` }),
		);
		session.addMessage({
			role: "assistant",
			content: `running step ${i}`,
			toolName: "bash",
			toolArgs: { command: `make step${i}` },
		});
		session.addMessage({ role: "toolResult", content: fakeOutput(i), tool: "bash" });
	}
	live.push(
		provider.complete("live final", { system, tools, messages: session.projectContext() }, { response: "all steps done" }),
	);
	session.addMessage({ role: "assistant", content: "all steps done" });

	return { session, provider, system, live };
}

/** Convenience: the message objects a pull-up turn appends (shared by tests). */
export function pullUpMessages(chunk: string, id = "A2"): { call: Message; result: Message } {
	return {
		call: {
			role: "assistant",
			content: "need the exact detail from the archive",
			toolName: "history_pull",
			toolArgs: { from: id, to: id },
		},
		result: { role: "toolResult", content: chunk, tool: "history_pull" },
	};
}
