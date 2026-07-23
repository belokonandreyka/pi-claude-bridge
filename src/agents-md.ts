// AGENTS.md discovery and sanitization for forwarding to Claude Code.
//
// Pi uses AGENTS.md for long-lived instructions; Claude Code reads the same
// content under "# CLAUDE.md". We forward BOTH the global ~/.pi/agent/AGENTS.md
// and the nearest project AGENTS.md (walking up from cwd) when both exist —
// global first, project second so project rules override general ones. Each
// block is prefixed with a separator naming its source path. Each body is
// sanitized independently: pi-specific references (~/.pi, .pi/, .pi, pi) are
// rewritten to their Claude Code equivalents, except inside fenced code blocks
// (``` ... ```) where shell commands like `which pi` must survive verbatim.
// Separator lines never enter the sanitizer, so their source paths stay intact.

import { existsSync, readFileSync, realpathSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

// Best-effort realpath so a symlinked walk-up to the same file as the global
// playbook is deduped. Falls back to the input if realpath fails (missing/perm).
function canonical(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

function globalAgentsPath(): string {
	return join(homedir(), ".pi", "agent", "AGENTS.md");
}

export function resolveAgentsMdPath(): string | undefined {
	const fromCwd = findAgentsMdInParents(process.cwd());
	if (fromCwd) return fromCwd;
	const g = globalAgentsPath();
	if (existsSync(g)) return g;
	return undefined;
}

export function findAgentsMdInParents(startDir: string): string | undefined {
	let current = resolve(startDir);
	while (true) {
		const candidate = join(current, "AGENTS.md");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

export interface ResolvedAgentsSources {
	global?: string;
	project?: string;
}

export function resolveAgentsMdSources(cwd: string = process.cwd()): ResolvedAgentsSources {
	const result: ResolvedAgentsSources = {};
	const g = globalAgentsPath();
	if (existsSync(g)) result.global = g;
	const p = findAgentsMdInParents(cwd);
	if (!p) return result;
	// Dedupe via realpath so a symlinked walk-up to the same file is not
	// emitted twice (result.global keeps its original literal path).
	const globalReal = result.global ? canonical(result.global) : undefined;
	if (globalReal && canonical(p) === globalReal) return result;
	result.project = p;
	return result;
}

function readTrimmed(path: string): string | undefined {
	try {
		const content = readFileSync(path, "utf-8").trim();
		return content.length > 0 ? content : undefined;
	} catch {
		return undefined;
	}
}

// Compose the merged AGENTS.md content from RAW (unsanitized) bodies joined
// with separator lines naming each source path. Sanitization is NOT applied
// here — extractAgentsAppend() sanitizes each body independently before
// composing (fenced code blocks are file-scoped, so per-body is equivalent to
// a single pass over concatenated bodies) and keeps the separators verbatim,
// which preserves pi-referencing paths (e.g. ~/.pi/agent/AGENTS.md, repo
// names containing "pi") for provenance.
//
// Single-file mode: when only one source is present, no separator is emitted
// so the output is byte-identical to the pre-merge upstream behavior.
export function composeAgentsContent(sources: ResolvedAgentsSources): string | undefined {
	const blocks: Array<{ path: string; body: string }> = [];
	if (sources.global) {
		const c = readTrimmed(sources.global);
		if (c) blocks.push({ path: sources.global, body: c });
	}
	if (sources.project) {
		const c = readTrimmed(sources.project);
		if (c) blocks.push({ path: sources.project, body: c });
	}
	if (blocks.length === 0) return undefined;
	if (blocks.length === 1) return blocks[0].body;
	return blocks.map((b) => `--- from ${b.path} ---\n\n${b.body}`).join("\n\n");
}

export function extractAgentsAppend(): string | undefined {
	const sources = resolveAgentsMdSources();
	const blocks: Array<{ path: string; body: string }> = [];
	if (sources.global) {
		const c = readTrimmed(sources.global);
		if (c) blocks.push({ path: sources.global, body: sanitizeAgentsContent(c) });
	}
	if (sources.project) {
		const c = readTrimmed(sources.project);
		if (c) blocks.push({ path: sources.project, body: sanitizeAgentsContent(c) });
	}
	if (blocks.length === 0) return undefined;
	const merged = blocks.length === 1
		? blocks[0].body
		: blocks.map((b) => `--- from ${b.path} ---\n\n${b.body}`).join("\n\n");
	return merged.length > 0 ? `# CLAUDE.md\n\n${merged}` : undefined;
}

function sanitizeSegment(text: string): string {
	let s = text;
	s = s.replace(/~\/\.pi\b/gi, "~/.claude");
	s = s.replace(/(^|[\s'"`])\.pi\//g, "$1.claude/");
	s = s.replace(/\b\.pi\b/gi, ".claude");
	s = s.replace(/\bpi\b/gi, "environment");
	return s;
}

// Sanitize content outside fenced code blocks. A fence opens on a line whose
// first non-whitespace run is 3+ backticks (optionally followed by an info
// string like ```bash) and closes on a later line whose first non-whitespace
// run is a backtick sequence of at least the opener's length. Everything from
// the opener line through the closer line (inclusive) is passed through
// verbatim so shell commands like `which pi` survive.
//
// Unterminated fence at EOF: if a fence opener has no matching closer, all
// remaining lines through EOF are treated as inside-fence and pass through
// verbatim. Deterministic and pinned by test.
export function sanitizeAgentsContent(content: string): string {
	const lines = content.split("\n");
	const out: string[] = [];
	const fenceOpen = /^[ \t]*(`{3,})([^`].*)?$/;
	let i = 0;
	while (i < lines.length) {
		const m = lines[i].match(fenceOpen);
		if (!m) {
			out.push(sanitizeSegment(lines[i]));
			i++;
			continue;
		}
		const ticks = m[1];
		const closeRe = new RegExp(`^[ \\t]*\`{${ticks.length},}[ \\t]*$`);
		out.push(lines[i]);
		i++;
		while (i < lines.length && !closeRe.test(lines[i])) {
			out.push(lines[i]);
			i++;
		}
		if (i < lines.length) {
			out.push(lines[i]);
			i++;
		}
	}
	return out.join("\n");
}
