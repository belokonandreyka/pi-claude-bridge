import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	AskOrchestratorState,
	createAskOrchestratorHandler,
	filterFallbackChain,
} from "../src/ask-orchestrator.js";

const noop = () => {};

// fallbackModel: null keeps step B out of these tests entirely, so nothing
// here can reach the network.
function makeHandler({ ui = null, config = {} } = {}) {
	return createAskOrchestratorHandler({
		getUI: () => ui,
		config: { fallbackModel: null, ...config },
		debug: noop,
		getDelegationBrief: () => "fix the failing test",
	});
}

const bodyOf = (result) => result.content.map((b) => b.text).join("");

describe("askOrchestrator", () => {
	it("returns the operator's answer when the dialog is answered", async () => {
		let seenTitle;
		const ui = {
			input: async (title) => {
				seenTitle = title;
				return "use the second option";
			},
		};
		const result = await makeHandler({ ui })(
			{ question: "which option?", recommendation: "the first" },
			new AskOrchestratorState(),
		);
		assert.match(bodyOf(result), /use the second option/);
		assert.match(seenTitle, /which option\?/);
	});

	it("hands back the agent's own recommendation when nobody answers", async () => {
		const ui = { input: async () => undefined }; // timeout resolves undefined
		const result = await makeHandler({ ui })(
			{ question: "which option?", recommendation: "keep the existing schema" },
			new AskOrchestratorState(),
		);
		assert.match(bodyOf(result), /keep the existing schema/);
	});

	it("falls through cleanly when there is no interactive UI", async () => {
		const result = await makeHandler({ ui: null })(
			{ question: "which option?", recommendation: "keep the existing schema" },
			new AskOrchestratorState(),
		);
		assert.match(bodyOf(result), /keep the existing schema/);
	});

	it("survives a dialog that throws", async () => {
		const ui = {
			input: async () => {
				throw new Error("no tty");
			},
		};
		const result = await makeHandler({ ui })(
			{ question: "which option?", recommendation: "keep the existing schema" },
			new AskOrchestratorState(),
		);
		assert.match(bodyOf(result), /keep the existing schema/);
	});

	it("caps questions per delegation so a confused agent cannot loop", async () => {
		// A distinctive fixture: the refusal text itself contains the word
		// "answered", so a generic token would match by accident.
		const REPLY = "OPERATOR_REPLY_TOKEN";
		const ui = { input: async () => REPLY };
		const handler = makeHandler({ ui, config: { maxPerQuery: 2 } });
		const state = new AskOrchestratorState();
		const args = { question: "q", recommendation: "r" };

		assert.match(bodyOf(await handler(args, state)), new RegExp(REPLY));
		assert.match(bodyOf(await handler(args, state)), new RegExp(REPLY));
		const third = bodyOf(await handler(args, state));
		assert.match(third, /limit/i);
		assert.doesNotMatch(third, new RegExp(REPLY));
	});

	it("does not open a dialog when no question was given", async () => {
		let opened = false;
		const ui = {
			input: async () => {
				opened = true;
				return "x";
			},
		};
		const result = await makeHandler({ ui })({ recommendation: "r" }, new AskOrchestratorState());
		assert.equal(opened, false);
		assert.match(bodyOf(result), /own judgement/i);
	});

	it("counts a refused question against the cap only once", async () => {
		const state = new AskOrchestratorState();
		const handler = makeHandler({ ui: { input: async () => "ok" }, config: { maxPerQuery: 1 } });
		await handler({ question: "q", recommendation: "r" }, state);
		assert.equal(state.asked, 1);
	});
});

describe("filterFallbackChain", () => {
	// Shape taken from the real ~/.pi/agent/model-fallback.json.
	const raw = {
		chain: [
			"claude-bridge/claude-opus-5",
			"claude-bridge/claude-sonnet-5",
			"github-copilot/claude-opus-4.7",
			"openai-codex/gpt-5.6-sol",
			"openrouter/google/gemini-3.7-flash",
		],
		paidEntries: ["openrouter/google/gemini-3.7-flash"],
	};

	it("drops claude-bridge entries, which would re-enter the delegation", () => {
		const out = filterFallbackChain(raw, true);
		assert.equal(out.some((c) => c.provider === "claude-bridge"), false);
	});

	it("skips paid entries unless explicitly allowed", () => {
		const free = filterFallbackChain(raw, false);
		assert.equal(free.some((c) => c.provider === "openrouter"), false);
		const paid = filterFallbackChain(raw, true);
		assert.deepEqual(paid.at(-1), { provider: "openrouter", id: "google/gemini-3.7-flash" });
	});

	it("keeps the operator's ordering", () => {
		assert.deepEqual(filterFallbackChain(raw, false), [
			{ provider: "github-copilot", id: "claude-opus-4.7" },
			{ provider: "openai-codex", id: "gpt-5.6-sol" },
		]);
	});

	it("splits only on a known provider prefix, so openrouter ids keep their slashes", () => {
		const out = filterFallbackChain({ chain: ["openrouter/google/gemini-3.7-flash"] }, false);
		assert.deepEqual(out, [{ provider: "openrouter", id: "google/gemini-3.7-flash" }]);
	});

	it("tolerates a missing or malformed file", () => {
		assert.deepEqual(filterFallbackChain(null, false), []);
		assert.deepEqual(filterFallbackChain({}, false), []);
		assert.deepEqual(filterFallbackChain({ chain: [1, "", null] }, false), []);
	});
});
