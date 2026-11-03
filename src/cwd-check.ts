import { statSync } from "fs";

/**
 * Claude Code is spawned in pi's cwd. When that directory is gone (a subagent's
 * worktree removed after its report), the spawn fails with ENOENT and the SDK
 * reports it as a native binary that "failed to launch" on the wrong libc.
 * node caches process.cwd(), so pi keeps showing the old path.
 */
export function missingCwdError(cwd: string): string | undefined {
	try {
		if (statSync(cwd).isDirectory()) return undefined;
	} catch {}
	return `The working directory ${cwd} no longer exists (a removed worktree?), so Claude Code cannot start in it and this session cannot continue there. Start a new pi session in an existing directory.`;
}
