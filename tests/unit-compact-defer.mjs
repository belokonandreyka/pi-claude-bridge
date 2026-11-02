#!/usr/bin/env node
// Unit tests for deferring threshold compaction mid-turn (compact-defer.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldDeferCompaction } from "../src/compact-defer.js";
import { QueryContext } from "../src/query-state.js";

const live = () => { const c = new QueryContext(); c.activeQuery = {}; return c; };
const idle = () => new QueryContext();

describe("shouldDeferCompaction", () => {
	it("defers a threshold compaction while a query is live", () => {
		assert.equal(shouldDeferCompaction("threshold", [idle(), live()]), true);
	});

	it("lets a threshold compaction run at the turn boundary", () => {
		assert.equal(shouldDeferCompaction("threshold", []), false);
		assert.equal(shouldDeferCompaction("threshold", [idle()]), false);
	});

	it("never defers overflow or manual compaction", () => {
		assert.equal(shouldDeferCompaction("overflow", [live()]), false);
		assert.equal(shouldDeferCompaction("manual", [live()]), false);
		assert.equal(shouldDeferCompaction(undefined, [live()]), false);
	});
});
