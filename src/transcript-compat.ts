// pi 0.86 changed what a custom `streamSimple` receives: the old `Context`
// ({ systemPrompt, tools, messages }) became a `TranscriptContext` whose system
// prompt and tool declarations live in `system` role entries inside `messages`
// (and may be amended mid-conversation). The bridge was written against the old
// shape — it indexes `messages` for its session cursor and only knows the
// user/assistant/toolResult roles — so every entry point converts back to that
// shape first. On pi <= 0.85 the helpers do not exist and the context is
// returned as is, which keeps one build working across the upgrade.
import * as piAi from "@earendil-works/pi-ai";
import type { Context, Tool } from "@earendil-works/pi-ai";

type AnyMessage = { role: string; [key: string]: unknown };

interface TranscriptHelpers {
	getCurrentSystemPrompt?: (messages: readonly AnyMessage[]) => string;
	getCurrentTools?: (messages: readonly AnyMessage[]) => Tool[];
}

export interface LegacyContext {
	systemPrompt?: string;
	tools?: Tool[];
	messages: Context["messages"];
}

/** Drop `system` transcript entries; indices of the remaining messages stay stable between calls. */
export function withoutSystemMessages<T extends { role: string }>(messages: readonly T[] | undefined): T[] {
	return (messages ?? []).filter((m) => m?.role !== "system");
}

export function toLegacyContext(context: unknown, helpers: TranscriptHelpers = piAi as unknown as TranscriptHelpers): LegacyContext {
	const c = (context ?? {}) as { systemPrompt?: string; tools?: Tool[]; messages?: AnyMessage[] };
	const messages = c.messages ?? [];
	const hasSystemEntries = messages.some((m) => m?.role === "system");
	if (!hasSystemEntries || typeof helpers.getCurrentSystemPrompt !== "function") {
		return { systemPrompt: c.systemPrompt, tools: c.tools, messages: withoutSystemMessages(messages) as unknown as Context["messages"] };
	}
	const systemPrompt = helpers.getCurrentSystemPrompt(messages) || c.systemPrompt || undefined;
	const tools = typeof helpers.getCurrentTools === "function" ? helpers.getCurrentTools(messages) : c.tools;
	return { systemPrompt, tools, messages: withoutSystemMessages(messages) as unknown as Context["messages"] };
}
