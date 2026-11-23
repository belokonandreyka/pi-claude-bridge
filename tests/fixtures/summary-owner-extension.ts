// Test fixture: an extension that owns the compaction summary, the way a
// context-guard style extension does. It announces itself under the shared
// global key and writes the summary with pi's own compact() through the model
// registry, so the summariser call reaches the bridge provider like any other.
export default function summaryOwner(pi: any): void {
	(globalThis as any)[Symbol.for("pi.compaction.summaryOwner")] = "test-owner";
	pi.on("session_before_compact", async (event: any, ctx: any) => {
		const defer = (globalThis as any)[Symbol.for("pi.compaction.shouldDefer")];
		if (typeof defer === "function" && defer(event, ctx) === true) return undefined;
		const { compact } = await import("@earendil-works/pi-coding-agent");
		const streamFn = (model: any, context: any, options: any) => ctx.modelRegistry.streamSimple(model, context, options);
		const result = await compact(event.preparation, ctx.model, undefined, undefined, "Keep it short.", event.signal, ctx.thinkingLevel, streamFn);
		return {
			compaction: {
				...result,
				summary: `${result.summary.trimEnd()}\n\nOWNER-NOTE: appended by the summary owner`,
				details: { ...((result.details as Record<string, unknown> | undefined) ?? {}), summaryOwner: "test-owner" },
			},
		};
	});
}
