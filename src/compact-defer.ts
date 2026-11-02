// Threshold compaction while a Claude Code query is live mid-turn.
//
// pi checks its compaction threshold before every assistant response, inside a
// turn too. The bridge serves a whole turn from one live Claude Code query: tool
// results go back into that query, which holds its own copy of the
// conversation. Compacting pi's history mid-turn cannot shrink it, so the next
// usage report is as large as before and pi compacts again, each pass a summary
// of a couple of minutes, until the turn ends and the next call rebuilds the
// session from the compacted history (2026-11-01: six compactions in a row at
// ~201k in one turn; 150 of 242 mpi compactions in ten days were such repeats).
//
// So a threshold compaction is deferred while any query is live; pi runs it again
// at the turn boundary, where the query has ended. Overflow and manual
// compactions are left alone: an overflow means the request already failed, and
// a manual /compact is the user's call.
export function shouldDeferCompaction(
	reason: string | undefined,
	contexts: Iterable<{ activeQuery: unknown }>,
): boolean {
	if (reason !== "threshold") return false;
	for (const c of contexts) {
		if (c.activeQuery !== null && c.activeQuery !== undefined) return true;
	}
	return false;
}
