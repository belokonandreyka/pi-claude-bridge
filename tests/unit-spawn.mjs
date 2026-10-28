/**
 * Claude Code runs in a process group of its own, so a terminal multiplexer that
 * reads the pane's foreground group (herdr) keeps seeing pi, not `claude`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { spawnInOwnProcessGroup } from "../src/spawn.js";

const pgid = (pid) => Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim());

describe("Claude Code spawn", () => {
	it("starts the child in its own process group, forwards stderr, exits on stdin EOF", async () => {
		const seen = [];
		const child = spawnInOwnProcessGroup((d) => seen.push(d))({
			command: "sh", args: ["-c", "echo boom >&2; cat"], env: process.env, signal: new AbortController().signal,
		});
		assert.notEqual(pgid(child.pid), pgid(process.pid));
		const out = [];
		child.stdout.on("data", (d) => out.push(String(d)));
		child.stdin.end("hello\n");
		const code = await new Promise((resolve) => child.once("exit", (c) => resolve(c)));
		assert.equal(code, 0);
		assert.equal(out.join(""), "hello\n");
		assert.match(seen.join(""), /boom/);
	});

	it("kills the child when the forwarded signal aborts", async () => {
		const ac = new AbortController();
		const child = spawnInOwnProcessGroup()({ command: "sleep", args: ["30"], env: process.env, signal: ac.signal });
		const exited = new Promise((resolve) => child.once("exit", (_c, s) => resolve(s)));
		ac.abort();
		assert.equal(await exited, "SIGTERM");
	});
});
