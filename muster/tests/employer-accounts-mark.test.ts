import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { EMPLOYER_ACCOUNTS_NOTICE, employerAccountsMark } from "../projects.ts";

/**
 * SK5 — the work-accounts marker and its one notice
 * (plans/secrets/key-management-blueprint-2026-10-16.md, section 5 step 7).
 *
 * The status line renders this marker beside the model and the project binding
 * shows its notice, so both read the same predicate: `UE` when the process runs
 * on the work accounts, `UE?` plus the notice when the directory belongs to an
 * acme-realty project and the process does not.
 */

test("SK5: a session on the work accounts shows UE", () => {
	assert.deepEqual(employerAccountsMark("acme-realty", "acme-realty"), { mark: "UE" });
	assert.deepEqual(employerAccountsMark("acme-realty", "personal"), { mark: "UE" });
});

test("SK5: a session on the personal accounts in a work directory shows UE? with the one notice", () => {
	assert.deepEqual(employerAccountsMark("personal", "acme-realty"), {
		mark: "UE?",
		notice: "This session runs on the personal accounts; start Pi in this repo for the work accounts.",
	});
	assert.equal(EMPLOYER_ACCOUNTS_NOTICE, "This session runs on the personal accounts; start Pi in this repo for the work accounts.");
	// An unset employer is the same case: the process never got the work keys.
	assert.equal(employerAccountsMark(undefined, "acme-realty")?.mark, "UE?");
});

test("SK5: a personal directory shows no marker, whatever the session runs on", () => {
	assert.equal(employerAccountsMark("personal", "personal"), null);
	assert.equal(employerAccountsMark(undefined, "personal"), null);
	assert.equal(employerAccountsMark("acme-realty", "personal")?.notice, undefined);
});
