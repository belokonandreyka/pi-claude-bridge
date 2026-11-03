#!/usr/bin/env node
// Unit tests for the missing-cwd guard (cwd-check.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingCwdError } from "../src/cwd-check.js";

describe("missingCwdError", () => {
	it("passes an existing directory", () => {
		assert.equal(missingCwdError(tmpdir()), undefined);
	});

	it("names a removed directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "cwd-check-"));
		rmSync(dir, { recursive: true });
		assert.match(missingCwdError(dir) ?? "", /no longer exists/);
		assert.ok(missingCwdError(dir)?.includes(dir));
	});

	it("rejects a file in place of a directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "cwd-check-"));
		const file = join(dir, "f");
		writeFileSync(file, "");
		assert.match(missingCwdError(file) ?? "", /no longer exists/);
		rmSync(dir, { recursive: true });
	});
});
