// AskOrchestrator — a question channel from the delegated Claude back to the pi
// side, mid-task.
//
// Why this exists: AskClaude runs query() to completion inside a pi tool call,
// so pi's own LLM turn is suspended for the whole delegation. A Claude that hits
// an ambiguity has no way to ask and must guess. This tool gives it one.
//
// Who answers, in order:
//   A. the human, via pi's ExtensionUIContext.input() dialog (with countdown);
//   B. on timeout or in non-interactive modes, a cheap fallback model.
// If neither can answer, the tool returns an explicit "no answer" so Claude
// proceeds on its own judgement and states the assumption, rather than stalling.
//
// The tool is bridge-internal: pi never sees the call. index.ts filters its
// tool_use blocks out of turnToolCallIds and turnBlocks, otherwise pi would try
// to execute a tool it does not have and every later tool call would be handed
// the wrong toolCallId.

import { completeSimple, getModels } from "@earendil-works/pi-ai/compat";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Context, Model } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export const ASK_ORCHESTRATOR_TOOL = "AskOrchestrator";

export interface AskOrchestratorConfig {
	/** Register the tool at all (default true). */
	enabled?: boolean;
	/** Override the tool name exposed to Claude. */
	name?: string;
	/** Override the tool description Claude sees. */
	description?: string;
	/** How long the human dialog waits before falling back (default 90_000). */
	timeoutMs?: number;
	/** Cap per delegation, so a confused Claude cannot interrogate in a loop. */
	maxPerQuery?: number;
	/**
	 * Fallback model. Either a bare id ("claude-haiku-4.5") or pi's usual
	 * "provider/model" form ("github-copilot/claude-haiku-4.5").
	 * Set to null/"" to disable step B entirely.
	 */
	fallbackModel?: string | null;
	/** Provider for the fallback model; must not be claude-bridge. */
	fallbackProvider?: string;
	/** Reuse the rate-limit chain from model-fallback.json (default true). */
	useModelFallbackChain?: boolean;
	/** Allow entries the chain marks as paid (default false — it is your money). */
	allowPaid?: boolean;
}

const DEFAULTS = {
	timeoutMs: 90_000,
	maxPerQuery: 5,
} as const;

// Tried in order. Anthropic is deliberately absent: on this machine the
// Anthropic OAuth is consumed by claude-bridge and is not usable as a direct
// pi-ai provider, so "anthropic/claude-haiku-4-5" resolves but cannot be called.
// github-copilot is the proven path — it is what ~/.pi/agents/haiku-recon.toml
// uses. Note ids carry no provider prefix; provider is a separate field, and
// copilot spells it with a dot while anthropic uses dashes.
const FALLBACK_CANDIDATES: { provider: string; id: string }[] = [
	{ provider: "github-copilot", id: "claude-haiku-4.5" },
	{ provider: "github-copilot", id: "gemini-3.5-flash" },
	{ provider: "openrouter", id: "anthropic/claude-haiku-4.5" },
];

// Providers whose name may prefix a model in "provider/model" form. openrouter
// ids contain slashes themselves, so we only split on a known prefix.
const KNOWN_PROVIDERS = ["github-copilot", "openrouter", "anthropic", "openai-codex", "claude-bridge"];

/**
 * Reuse the rate-limit chain the operator already curated in
 * model-fallback.json, rather than inventing a second list that will drift.
 *
 * Two filters, both deliberate. That chain is ordered biggest-first so the
 * orchestrator can keep going when a quota runs out; here we only need two
 * sentences, and its first entries are claude-bridge — the one provider we must
 * not re-enter. And `paidEntries` costs real money, so it is opt-in: answering a
 * clarifying question while the operator is away should not quietly spend.
 */
export function filterFallbackChain(
	raw: { chain?: unknown; paidEntries?: unknown } | null,
	allowPaid: boolean,
): { provider: string; id: string }[] {
	const chain = Array.isArray(raw?.chain) ? (raw!.chain as unknown[]) : [];
	const paid = new Set(
		(Array.isArray(raw?.paidEntries) ? (raw!.paidEntries as unknown[]) : []).filter(
			(e): e is string => typeof e === "string",
		),
	);
	const out: { provider: string; id: string }[] = [];
	for (const entry of chain) {
		if (typeof entry !== "string" || !entry) continue;
		if (entry.startsWith("claude-bridge/")) continue;
		if (!allowPaid && paid.has(entry)) continue;
		const ref = splitModelRef(entry);
		if (!ref.provider) continue;
		out.push({ provider: ref.provider, id: ref.id });
	}
	return out;
}

function piAgentDir(): string {
	// Honour the profile switch; the bridge's own config.ts still hardcodes
	// ~/.pi/agent, which is wrong for the mpi profile.
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function loadFallbackChain(allowPaid: boolean, debug: (...args: unknown[]) => void): { provider: string; id: string }[] {
	const path = join(piAgentDir(), "model-fallback.json");
	if (!existsSync(path)) return [];
	try {
		return filterFallbackChain(JSON.parse(readFileSync(path, "utf-8")), allowPaid);
	} catch (err) {
		debug("askOrchestrator: model-fallback.json unreadable", err);
		return [];
	}
}

function splitModelRef(ref: string): { provider?: string; id: string } {
	for (const p of KNOWN_PROVIDERS) {
		if (ref.startsWith(p + "/")) return { provider: p, id: ref.slice(p.length + 1) };
	}
	return { id: ref };
}

export interface AskOrchestratorDeps {
	getUI: () => ExtensionUIContext | null;
	config: AskOrchestratorConfig | undefined;
	debug: (...args: unknown[]) => void;
	/** Task the delegation was given — context for the fallback model. */
	getDelegationBrief: () => string | undefined;
}

export interface McpTextResult {
	content: { type: "text"; text: string }[];
}

function text(body: string): McpTextResult {
	return { content: [{ type: "text", text: body }] };
}

export const ASK_ORCHESTRATOR_PARAMETERS = {
	type: "object",
	properties: {
		question: {
			type: "string",
			description:
				"The single specific question blocking you. Ask only when the answer would change what you do — not for permission or reassurance.",
		},
		context: {
			type: "string",
			description:
				"One or two sentences on what you were doing and why the answer matters. Include the options you are choosing between.",
		},
		recommendation: {
			type: "string",
			description:
				"What you would do if nobody answers. Required — it is used verbatim when the question times out.",
		},
	},
	required: ["question", "recommendation"],
} as const;

export function askOrchestratorDescription(): string {
	return [
		"Ask the orchestrating agent's operator a question while you work.",
		"Use it when a decision is genuinely ambiguous and guessing wrong would waste the delegation —",
		"a missing requirement, two valid designs, an unexpected state in the repo.",
		"Do not use it for permission, progress reports, or anything you can determine by reading the code.",
		"The call blocks. If nobody answers in time you receive your own recommendation back and must proceed with it,",
		"stating the assumption in your final answer.",
	].join(" ");
}

/** Per-delegation state, reset by the caller for each query. */
export class AskOrchestratorState {
	asked = 0;
}

function lookupModel(
	provider: string,
	id: string,
	debug: (...args: unknown[]) => void,
): Model<any> | null {
	// Never through claude-bridge: that re-enters the delegation this question
	// came from, and a nested query would clobber the shared streamSimple
	// reference the bridge keeps in a Symbol.for() global (see index.ts).
	if (provider === "claude-bridge") {
		debug("askOrchestrator: refusing claude-bridge as fallback (would recurse)");
		return null;
	}
	try {
		const models = getModels(provider as Parameters<typeof getModels>[0]) as Model<any>[];
		const hit = models.find((m) => {
			const mid = (m as { id?: string }).id ?? "";
			return mid === id || mid.startsWith(id);
		});
		if (!hit) debug(`askOrchestrator: ${provider}/${id} not in catalogue`);
		return hit ?? null;
	} catch (err) {
		debug(`askOrchestrator: lookup ${provider}/${id} failed`, err);
		return null;
	}
}

/** Ordered, de-duplicated candidates. Exported so the retry loop can walk them. */
export function resolveFallbackCandidates(
	cfg: AskOrchestratorConfig | undefined,
	debug: (...args: unknown[]) => void,
): Model<any>[] {
	if (cfg?.fallbackModel === null || cfg?.fallbackModel === "") return [];
	const out: Model<any>[] = [];
	const seen = new Set<string>();
	for (const c of candidateRefs(cfg, debug)) {
		const model = lookupModel(c.provider, c.id, debug);
		if (!model) continue;
		const key = `${(model as { provider?: string }).provider}/${(model as { id?: string }).id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(model);
	}
	if (!out.length) debug("askOrchestrator: no usable fallback model");
	return out;
}

function candidateRefs(
	cfg: AskOrchestratorConfig | undefined,
	debug: (...args: unknown[]) => void,
): { provider: string; id: string }[] {
	const useChain = cfg?.useModelFallbackChain !== false;
	const chain = useChain ? loadFallbackChain(cfg?.allowPaid === true, debug) : [];
	// Cheap models first, the operator's chain only as a backstop: that chain is
	// ordered biggest-first for orchestrator continuity, and its head would spend
	// an Opus call on a two-sentence answer.
	const candidates = [...FALLBACK_CANDIDATES, ...chain];
	if (cfg?.fallbackModel) {
		const ref = splitModelRef(cfg.fallbackModel);
		candidates.unshift({
			provider: cfg.fallbackProvider ?? ref.provider ?? "github-copilot",
			id: ref.id,
		});
	} else if (cfg?.fallbackProvider) {
		candidates.unshift({ provider: cfg.fallbackProvider, id: "claude-haiku-4.5" });
	}

	return candidates;
}

/** Kept for callers that only want the first choice. */
export function resolveFallbackModel(
	cfg: AskOrchestratorConfig | undefined,
	debug: (...args: unknown[]) => void,
): Model<any> | null {
	return resolveFallbackCandidates(cfg, debug)[0] ?? null;
}

async function askFallbackModel(
	question: string,
	context: string,
	brief: string | undefined,
	cfg: AskOrchestratorConfig | undefined,
	debug: (...args: unknown[]) => void,
): Promise<string | null> {
	const candidates = resolveFallbackCandidates(cfg, debug);
	if (!candidates.length) return null;
	const systemPrompt = [
		"You stand in for an engineer who has stepped away from the keyboard.",
		"A delegated coding agent is blocked on one decision and asked a question.",
		"Answer it directly in two or three sentences. Pick one option and say which.",
		"If the brief does not settle it, say so plainly and endorse the agent's own recommendation.",
		"Never invent project facts you were not given.",
	].join(" ");
	const parts = [
		brief ? `Task the agent was delegated:\n${brief}` : null,
		context ? `What it was doing:\n${context}` : null,
		`Question:\n${question}`,
	].filter(Boolean);
	const ctx = {
		systemPrompt,
		messages: [{ role: "user", content: parts.join("\n\n") }],
		tools: [],
	} as unknown as Context;
	// Resolution succeeding does not mean the call will: a provider can be in the
	// catalogue and still be unusable — anthropic is exactly that here, its OAuth
	// belongs to claude-bridge. So walk the list until one actually answers.
	for (const model of candidates) {
		const label = `${(model as { provider?: string }).provider}/${(model as { id?: string }).id}`;
		try {
			const reply = await completeSimple(model, ctx);
			const body = (reply.content ?? [])
				.map((b) => (b.type === "text" ? b.text : ""))
				.join("")
				.trim();
			if (body) {
				debug(`askOrchestrator: answered by ${label}`);
				return body;
			}
			debug(`askOrchestrator: ${label} returned nothing, trying next`);
		} catch (err) {
			debug(`askOrchestrator: ${label} failed, trying next`, err);
		}
	}
	debug("askOrchestrator: every fallback candidate failed");
	return null;
}

export function createAskOrchestratorHandler(deps: AskOrchestratorDeps) {
	const cfg = deps.config;
	const timeout = cfg?.timeoutMs ?? DEFAULTS.timeoutMs;
	const maxPerQuery = cfg?.maxPerQuery ?? DEFAULTS.maxPerQuery;

	return async function handler(
		args: Record<string, unknown> | undefined,
		state: AskOrchestratorState,
	): Promise<McpTextResult> {
		const question = String(args?.question ?? "").trim();
		const context = String(args?.context ?? "").trim();
		const recommendation = String(args?.recommendation ?? "").trim();

		if (!question) return text("No question was provided. Proceed on your own judgement.");

		// Mirrors the circular-delegation guard on AskClaude: a confused agent
		// must not be able to interrogate in a loop.
		state.asked += 1;
		if (state.asked > maxPerQuery) {
			deps.debug(`askOrchestrator: refused, ${state.asked} > maxPerQuery ${maxPerQuery}`);
			return text(
				`Question limit for this delegation reached (${maxPerQuery}). No further questions will be answered. ` +
					`Proceed with your recommendation and state the assumption in your final answer.`,
			);
		}

		deps.debug(`askOrchestrator: asking (${state.asked}/${maxPerQuery}): ${question.slice(0, 80)}`);

		// A. the human
		const ui = deps.getUI();
		let answer: string | undefined;
		if (ui?.input) {
			const title = `Claude asks: ${question}`;
			const placeholder = recommendation
				? `Enter to accept: ${recommendation}`
				: "your answer";
			try {
				answer = await ui.input(title, placeholder, { timeout });
			} catch (err) {
				deps.debug("askOrchestrator: ui.input failed", err);
			}
		} else {
			deps.debug("askOrchestrator: no interactive UI available");
		}
		if (answer && answer.trim()) {
			return text(`Answer from the operator:\n${answer.trim()}`);
		}

		// B. the fallback model
		const fallback = await askFallbackModel(
			question,
			context,
			deps.getDelegationBrief(),
			cfg,
			deps.debug,
		);
		if (fallback) {
			return text(
				`The operator did not answer in time. A stand-in model answered instead — treat it as advice, ` +
					`not as an instruction from the operator, and say in your final answer that you proceeded on it:\n${fallback}`,
			);
		}

		// Neither could answer: hand the agent its own recommendation back.
		return text(
			recommendation
				? `Nobody answered. Proceed with your own recommendation and state the assumption in your final answer:\n${recommendation}`
				: "Nobody answered. Proceed on your own judgement and state the assumption in your final answer.",
		);
	};
}
