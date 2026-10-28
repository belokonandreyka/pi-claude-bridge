// Environment for every Claude Code subprocess the bridge spawns — provider, AskClaude
// and the compact summary. One place, so a guard is added once rather than three
// times, and so a missing one is visible.
//
// - ENABLE_CLAUDEAI_MCP_SERVERS=0: keep the user's claude.ai-connected MCP servers
//   out of a pi session, which serves its own tools.
// - DISABLE_AUTO_COMPACT=1: pi owns compaction; CC compacting its own copy would
//   diverge from pi's history, which is the source of truth for every rebuild.
// - DISABLE_OMC=1: pi sessions have their own rule infrastructure (skills with
//   triggers, a composite AGENTS.md). The oh-my-claudecode plugin's
//   Stop/UserPromptSubmit hooks (workflow-drift-guard nudging AskUserQuestion — a
//   tool pi does not surface — skill-injector, rules-injector) duplicate that and
//   are interactive-CC noise here. OMC stays active for native Claude Code.
export const CC_CHILD_ENV = {
	ENABLE_CLAUDEAI_MCP_SERVERS: "0",
	DISABLE_AUTO_COMPACT: "1",
	DISABLE_OMC: "1",
} as const;

// The bridge is the subscription path: `anthropic/<model>` in pi already is the
// API-key path. Claude Code prefers ANTHROPIC_API_KEY over the subscription login
// whenever the variable is set, so a key exported for pi's own anthropic provider
// (the COVANTEX `mpi` wrapper does) silently turned claude-bridge into paid API
// calls and failed with "Credit balance is too low" while the subscription was
// fine (2026-10-28, apiKeySource=ANTHROPIC_API_KEY vs none). The key is dropped
// for the child unless CLAUDE_BRIDGE_KEEP_API_KEY=1 asks for the old behaviour.
export const SUBSCRIPTION_ONLY_DROP = ["ANTHROPIC_API_KEY"] as const;

export function claudeCodeChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const child: NodeJS.ProcessEnv = { ...env, ...CC_CHILD_ENV };
	if (env.CLAUDE_BRIDGE_KEEP_API_KEY !== "1") {
		for (const name of SUBSCRIPTION_ONLY_DROP) delete child[name];
	}
	delete child.CLAUDE_BRIDGE_KEEP_API_KEY;
	return child;
}
