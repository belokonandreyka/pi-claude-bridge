import { spawn } from "node:child_process";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

// The SDK's default spawn puts Claude Code in pi's process group, which is the
// terminal's foreground group. Terminal multiplexers that detect the agent of a
// pane from that group (herdr) then see `claude` next to `pi` and label the pane
// as Claude Code; the state pi reports through its own integration no longer
// matches and the pane sits at "idle" while pi works (2026-10-28). The child
// needs no terminal (stream-json over pipes), so it starts in a group of its
// own. It still ends with pi: the SDK closes its stdin, and Claude Code exits on
// EOF; the forwarded abort signal kills it after the SDK's grace window.
//
// A custom spawner owns stderr (the SDK only reads it from its built-in spawn),
// so it is drained here and handed to `onStderr`, the debug capture when on.
export function spawnInOwnProcessGroup(onStderr?: (data: string) => void): (options: SpawnOptions) => SpawnedProcess {
	return (options) => {
		const child = spawn(options.command, options.args, {
			cwd: options.cwd,
			env: options.env,
			signal: options.signal,
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (data: string) => onStderr?.(data));
		// An abort raises an AbortError on the child; the SDK learns about it from
		// the exit event, so this listener only keeps it from becoming uncaught.
		child.on("error", () => {});
		return child as unknown as SpawnedProcess;
	};
}
