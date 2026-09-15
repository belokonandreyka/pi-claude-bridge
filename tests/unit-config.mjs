import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.js";

function withTempHome(fn) {
	const oldHome = process.env.HOME;
	const home = mkdtempSync(join(tmpdir(), "claude-bridge-home-"));
	try {
		process.env.HOME = home;
		return fn(home);
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		rmSync(home, { recursive: true, force: true });
	}
}

describe("loadConfig", () => {
	it("loads project config from Pi's configured project directory", () => withTempHome(() => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const configDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(configDir, { recursive: true });
			writeFileSync(join(configDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "max" },
				askClaude: { enabled: false },
			}));

			assert.deepEqual(loadConfig(cwd), {
				provider: { plan: "max" },
				askClaude: { enabled: false },
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("merges project config over global config", () => withTempHome((home) => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const globalDir = join(home, ".pi", "agent");
			const projectDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(globalDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(globalDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "pro", strictMcpConfig: true },
				askClaude: { enabled: true, defaultMode: "read" },
			}));
			writeFileSync(join(projectDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "max" },
				askClaude: { enabled: false },
			}));

			assert.deepEqual(loadConfig(cwd), {
				provider: { plan: "max", strictMcpConfig: true },
				askClaude: { enabled: false, defaultMode: "read" },
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));
});


it("piAgentDir follows PI_CODING_AGENT_DIR and falls back to ~/.pi/agent", async () => {
	const { piAgentDir } = await import("../src/config.ts");
	assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "/tmp/pi-personal/agent", HOME: "/tmp/h" }), "/tmp/pi-personal/agent");
	assert.equal(piAgentDir({ HOME: "/tmp/h" }), "/tmp/h/.pi/agent");
});

it("loadConfig and the global AGENTS.md come from the active profile, not ~/.pi/agent", async () => {
	const os = await import("node:os");
	const fs = await import("node:fs");
	const path = await import("node:path");
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-profile-"));
	const work = path.join(home, ".pi", "agent");
	const personal = path.join(home, ".pi-personal", "agent");
	fs.mkdirSync(work, { recursive: true });
	fs.mkdirSync(personal, { recursive: true });
	fs.writeFileSync(path.join(work, "claude-bridge.json"), JSON.stringify({ provider: { plan: "pro" } }));
	fs.writeFileSync(path.join(personal, "claude-bridge.json"), JSON.stringify({ provider: { plan: "max" } }));
	fs.writeFileSync(path.join(work, "AGENTS.md"), "work rules");
	fs.writeFileSync(path.join(personal, "AGENTS.md"), "personal rules");
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cwd-"));
	const saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
	try {
		process.env.HOME = home;
		process.env.PI_CODING_AGENT_DIR = personal;
		const { loadConfig } = await import("../src/config.ts");
		const { resolveAgentsMdPath } = await import("../src/agents-md.ts");
		assert.equal(loadConfig(cwd).provider.plan, "max");
		const prevCwd = process.cwd();
		process.chdir(cwd);
		try {
			assert.equal(resolveAgentsMdPath(), path.join(personal, "AGENTS.md"));
		} finally {
			process.chdir(prevCwd);
		}
		delete process.env.PI_CODING_AGENT_DIR;
		assert.equal(loadConfig(cwd).provider.plan, "pro");
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
});
