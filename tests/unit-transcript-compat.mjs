import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { toLegacyContext, withoutSystemMessages } from "../src/transcript-compat.js";

const user = (t) => ({ role: "user", content: t, timestamp: 1 });
const assistant = (t) => ({ role: "assistant", content: [{ type: "text", text: t }] });
const tool = (name) => ({ name, description: `${name} tool`, parameters: { type: "object", properties: {} } });

describe("toLegacyContext", () => {
	it("passes a pi <= 0.85 context through untouched", () => {
		const ctx = { systemPrompt: "SYS", tools: [tool("read")], messages: [user("hi"), assistant("yo")] };
		const out = toLegacyContext(ctx, {});
		assert.equal(out.systemPrompt, "SYS");
		assert.deepEqual(out.tools.map((t) => t.name), ["read"]);
		assert.equal(out.messages.length, 2);
	});

	it("reads prompt and tools from a 0.86 transcript and strips system entries", () => {
		const messages = [
			{ role: "system", content: "BASE", toolsAdded: [tool("read"), tool("bash")] },
			user("hi"),
			assistant("yo"),
			{ role: "system", content: "EXTRA", toolsRemoved: [{ name: "bash" }] },
			user("again"),
		];
		const helpers = {
			getCurrentSystemPrompt: (ms) => ms.filter((m) => m.role === "system").map((m) => m.content).join("\n\n"),
			getCurrentTools: () => [tool("read")],
		};
		const out = toLegacyContext({ messages }, helpers);
		assert.equal(out.systemPrompt, "BASE\n\nEXTRA");
		assert.deepEqual(out.tools.map((t) => t.name), ["read"]);
		assert.deepEqual(out.messages.map((m) => m.role), ["user", "assistant", "user"]);
	});

	it("keeps message indices stable when a system entry appears mid-conversation", () => {
		const helpers = { getCurrentSystemPrompt: () => "S", getCurrentTools: () => [] };
		const before = toLegacyContext({ messages: [{ role: "system", content: "S" }, user("a"), assistant("b")] }, helpers);
		const after = toLegacyContext({ messages: [{ role: "system", content: "S" }, user("a"), assistant("b"), { role: "system", content: "T" }, user("c")] }, helpers);
		assert.equal(before.messages.length, 2);
		assert.equal(after.messages.length, 3);
		assert.deepEqual(after.messages.slice(0, 2), before.messages);
	});

	it("falls back to legacy fields when helpers are missing but system entries exist", () => {
		const out = toLegacyContext({ systemPrompt: "OLD", messages: [{ role: "system", content: "x" }, user("a")] }, {});
		assert.equal(out.systemPrompt, "OLD");
		assert.deepEqual(out.messages.map((m) => m.role), ["user"]);
	});

	it("tolerates empty input", () => {
		assert.deepEqual(toLegacyContext(undefined, {}).messages, []);
		assert.deepEqual(withoutSystemMessages(undefined), []);
	});
});

// Exercise the real pi-ai 0.86 helpers when a copy is available (PI_AI_086 points at its package dir).
const real = process.env.PI_AI_086;
describe("against the real pi-ai 0.86 helpers", { skip: !real || !existsSync(real) }, () => {
	it("resolves prompt and tools exactly as pi does", async () => {
		const piAi = await import(`${real}/dist/index.js`);
		const messages = [
			{ role: "system", content: "BASE", toolsAdded: [tool("read"), tool("bash")] },
			user("hi"),
			{ role: "system", content: "LATER", toolsRemoved: [{ name: "bash" }] },
		];
		const out = toLegacyContext({ messages }, piAi);
		assert.match(out.systemPrompt, /BASE/);
		assert.match(out.systemPrompt, /LATER/);
		assert.deepEqual(out.tools.map((t) => t.name), ["read"]);
		assert.deepEqual(out.messages.map((m) => m.role), ["user"]);
	});
});
