import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	composeAgentsContent,
	extractAgentsAppend,
	resolveAgentsMdSources,
	sanitizeAgentsContent,
} from "../src/agents-md.js";

function withTempHomeAndCwd(fn) {
	const oldHome = process.env.HOME;
	const oldCwd = process.cwd();
	const home = mkdtempSync(join(tmpdir(), "cb-agentsmd-home-"));
	const cwd = mkdtempSync(join(tmpdir(), "cb-agentsmd-cwd-"));
	try {
		process.env.HOME = home;
		process.chdir(cwd);
		return fn({ home, cwd });
	} finally {
		process.chdir(oldCwd);
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
}

function writeGlobal(home, body) {
	const dir = join(home, ".pi", "agent");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "AGENTS.md");
	writeFileSync(path, body);
	return path;
}

function writeProject(cwd, body) {
	const path = join(cwd, "AGENTS.md");
	writeFileSync(path, body);
	return path;
}

describe("sanitizeAgentsContent — fenced code blocks", () => {
	it("leaves ```bash fences untouched while rewriting outside", () => {
		const input = [
			"Use ~/.pi for pi config.",
			"",
			"```bash",
			"which pi",
			"ls ~/.pi/agent",
			"```",
			"",
			"After the fence, pi means the tool.",
		].join("\n");
		const out = sanitizeAgentsContent(input);
		assert.match(out, /Use ~\/\.claude for environment config\./);
		assert.match(out, /which pi\n/);
		assert.match(out, /ls ~\/\.pi\/agent/);
		assert.match(out, /After the fence, environment means the tool\./);
	});

	it("handles nested backticks and info strings", () => {
		const input = "```\npi is safe here\n```\npi outside";
		const out = sanitizeAgentsContent(input);
		assert.match(out, /pi is safe here/);
		assert.match(out, /environment outside/);
	});

	it("still rewrites when there are no fences (single-file behavior)", () => {
		assert.equal(
			sanitizeAgentsContent("run pi at ~/.pi"),
			"run environment at ~/.claude",
		);
	});
});

describe("resolveAgentsMdSources / composeAgentsContent", () => {
	it("merges global first then project when both exist", () => withTempHomeAndCwd(({ home, cwd }) => {
		const g = writeGlobal(home, "GLOBAL BODY");
		const p = writeProject(cwd, "PROJECT BODY");
		const sources = resolveAgentsMdSources(cwd);
		assert.equal(sources.global, g);
		assert.equal(sources.project, p);
		const composed = composeAgentsContent(sources);
		assert.ok(composed);
		const gIdx = composed.indexOf("GLOBAL BODY");
		const pIdx = composed.indexOf("PROJECT BODY");
		assert.ok(gIdx > -1 && pIdx > -1);
		assert.ok(gIdx < pIdx, "global must come before project");
		assert.ok(composed.includes(`--- from ${g} ---`));
		assert.ok(composed.includes(`--- from ${p} ---`));
	}));

	it("no shadowing: project AGENTS.md does not hide the global playbook", () => withTempHomeAndCwd(({ home, cwd }) => {
		writeGlobal(home, "GLOBAL PLAYBOOK CONTENT");
		writeProject(cwd, "PROJECT RULES");
		const append = extractAgentsAppend();
		assert.ok(append);
		assert.match(append, /^# CLAUDE\.md/);
		assert.ok(append.includes("GLOBAL PLAYBOOK CONTENT"));
		assert.ok(append.includes("PROJECT RULES"));
	}));

	it("single-file fallback: only global", () => withTempHomeAndCwd(({ home }) => {
		writeGlobal(home, "ONLY GLOBAL");
		const append = extractAgentsAppend();
		assert.ok(append);
		assert.ok(append.includes("ONLY GLOBAL"));
	}));

	it("single-file fallback: only project", () => withTempHomeAndCwd(({ cwd }) => {
		writeProject(cwd, "ONLY PROJECT");
		const append = extractAgentsAppend();
		assert.ok(append);
		assert.ok(append.includes("ONLY PROJECT"));
	}));

	it("returns undefined when neither exists", () => withTempHomeAndCwd(() => {
		assert.equal(extractAgentsAppend(), undefined);
	}));

	it("does not duplicate when project walk-up lands on the global file", () => withTempHomeAndCwd(({ home }) => {
		// cwd inside ~/.pi/agent — walk-up would find the global AGENTS.md.
		const g = writeGlobal(home, "SAME FILE");
		const inner = join(home, ".pi", "agent");
		process.chdir(inner);
		const sources = resolveAgentsMdSources(inner);
		assert.equal(sources.global, g);
		assert.equal(sources.project, undefined);
	}));

	it("sanitizes each body independently and preserves fences from either source", () => withTempHomeAndCwd(({ home, cwd }) => {
		writeGlobal(home, "Global says pi.\n\n```bash\nwhich pi\n```\n");
		writeProject(cwd, "Project mentions ~/.pi too.\n\n```\nls ~/.pi\n```\n");
		const append = extractAgentsAppend();
		assert.ok(append);
		assert.match(append, /Global says environment\./);
		assert.match(append, /Project mentions ~\/\.claude too\./);
		assert.match(append, /which pi/);
		assert.match(append, /ls ~\/\.pi/);
	}));

	it("separator paths survive sanitization verbatim (repo name contains 'pi', path contains '.pi')", () => {
		const oldHome = process.env.HOME;
		const oldCwd = process.cwd();
		const home = mkdtempSync(join(tmpdir(), "cb-sep-home-"));
		// Deliberately synthesize a cwd whose leaf directory has 'pi' as a
		// word-bounded token — this is the exact pattern that used to be
		// corrupted by the sanitizer (pi-claude-bridge → environment-claude-bridge).
		const parent = mkdtempSync(join(tmpdir(), "cb-sep-parent-"));
		const cwd = join(parent, "pi-claude-bridge");
		mkdirSync(cwd);
		try {
			process.env.HOME = home;
			process.chdir(cwd);
			const g = writeGlobal(home, "global body");
			writeProject(cwd, "project body");
			const append = extractAgentsAppend();
			assert.ok(append);
			// Global path is passed literally (via HOME), project path may go through
			// /private/var on macOS — assert the crucial substrings survive verbatim.
			assert.ok(append.includes(`--- from ${g} ---`), `separator for global must contain literal path, got: ${append}`);
			assert.match(append, /--- from .*\/pi-claude-bridge\/AGENTS\.md ---/);
			assert.ok(!append.includes("environment-claude-bridge"), "repo-name 'pi' in separator path must NOT be rewritten");
			assert.ok(!append.includes(".environment/agent/AGENTS.md"), "'.pi' path segment in separator must NOT be rewritten");
		} finally {
			process.chdir(oldCwd);
			if (oldHome === undefined) delete process.env.HOME;
			else process.env.HOME = oldHome;
			rmSync(home, { recursive: true, force: true });
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("realpath-dedupes when project walk-up reaches global via a symlinked path", () => {
		const oldHome = process.env.HOME;
		const oldCwd = process.cwd();
		const home = mkdtempSync(join(tmpdir(), "cb-sym-home-"));
		const linkParent = mkdtempSync(join(tmpdir(), "cb-sym-link-"));
		try {
			process.env.HOME = home;
			writeGlobal(home, "GLOBAL VIA SYMLINK");
			// Symlink linkParent/agent → ~/.pi/agent. Walk-up from linkParent/agent
			// finds the same AGENTS.md file (via the link), literal path differs.
			const realAgentDir = join(home, ".pi", "agent");
			const linkDir = join(linkParent, "agent");
			symlinkSync(realAgentDir, linkDir);
			process.chdir(linkDir);
			const sources = resolveAgentsMdSources(linkDir);
			assert.ok(sources.global);
			assert.equal(sources.project, undefined, "symlinked walk-up to the same real file must be deduped");
		} finally {
			process.chdir(oldCwd);
			if (oldHome === undefined) delete process.env.HOME;
			else process.env.HOME = oldHome;
			rmSync(home, { recursive: true, force: true });
			rmSync(linkParent, { recursive: true, force: true });
		}
	});

	it("single-file mode emits no separator (byte-identical to sanitized body)", () => withTempHomeAndCwd(({ home }) => {
		writeGlobal(home, "just the body, pi is a tool");
		const append = extractAgentsAppend();
		assert.equal(append, "# CLAUDE.md\n\njust the body, environment is a tool");
		assert.ok(!append.includes("--- from "), "single source must not emit a separator");
	}));
});

describe("sanitizeAgentsContent — unterminated fence at EOF (pinned behavior)", () => {
	it("leaves all content after a dangling fence opener verbatim through EOF", () => {
		const input = [
			"before: pi outside",
			"```bash",
			"which pi",
			"ls ~/.pi",
			"no closing fence follows",
		].join("\n");
		const out = sanitizeAgentsContent(input);
		assert.match(out, /before: environment outside/);
		assert.match(out, /which pi\n/);
		assert.match(out, /ls ~\/\.pi\n/);
		assert.match(out, /no closing fence follows$/);
	});
});
