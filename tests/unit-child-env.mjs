/**
 * Every Claude Code subprocess the bridge spawns has to be told to keep its hands
 * off state pi owns. These are silent when missing: CC compacts or writes memory
 * on its own, nothing throws, and the damage shows up in the user's ~/.claude
 * rather than in a test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { __test } = await import("../src/index.js");
const { claudeCodeChildEnv } = await import("../src/child-env.js");

describe("Claude Code child environment", () => {
	it("disables auto-compaction, claude.ai MCP servers and oh-my-claudecode hooks", () => {
		assert.deepEqual(__test.CC_CHILD_ENV, {
			ENABLE_CLAUDEAI_MCP_SERVERS: "0",
			DISABLE_AUTO_COMPACT: "1",
			DISABLE_OMC: "1",
		});
	});

	// Deliberately not asserted here: that every `query()` call site builds its env
	// with claudeCodeChildEnv(). The only way to check that from a unit test is to
	// grep src/index.ts, which fails on innocent indirection (`env: childEnv`) and
	// would have to be taught about it — a brittle test that reads as coverage. The
	// three call sites are the guard, and a fourth is a review question.

	it("drops ANTHROPIC_API_KEY so the bridge uses the subscription login", () => {
		const env = claudeCodeChildEnv({ ANTHROPIC_API_KEY: "sk-test", CLAUDE_CONFIG_DIR: "/c", PATH: "/bin" });
		assert.equal(env.ANTHROPIC_API_KEY, undefined);
		assert.equal(env.CLAUDE_CONFIG_DIR, "/c");
		assert.equal(env.DISABLE_AUTO_COMPACT, "1");
	});

	it("keeps the key only when CLAUDE_BRIDGE_KEEP_API_KEY=1, and never forwards the switch", () => {
		const env = claudeCodeChildEnv({ ANTHROPIC_API_KEY: "sk-test", CLAUDE_BRIDGE_KEEP_API_KEY: "1" });
		assert.equal(env.ANTHROPIC_API_KEY, "sk-test");
		assert.equal(env.CLAUDE_BRIDGE_KEEP_API_KEY, undefined);
	});

	it("does not touch the parent environment", () => {
		const parent = { ANTHROPIC_API_KEY: "sk-test" };
		claudeCodeChildEnv(parent);
		assert.equal(parent.ANTHROPIC_API_KEY, "sk-test");
	});
});
