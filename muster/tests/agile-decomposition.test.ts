import "./muster-test-isolation.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	acceptDecompositionRevision,
	assessRevisionImpact,
	canDispatchTask,
	computeReadyFrontier,
	fileDecompositionStore,
	proposeDecompositionRevision,
	resolveBacklogSource,
	taskContractHash,
	validateDecomposition,
	type DecompositionState,
	type TaskContractInput,
} from "../agile.ts";

/**
 * P4 decomposition behaviour (plan §7.1, §7.1.1): structural validation,
 * missing references, cycles, coverage, shared-writer conflicts, fabricated
 * review flags, accepted-revision compare-and-set, review provenance, carried
 * forward evidence, frontier capacity/ownership and the inactive Jira gate.
 *
 * Authored here; executed by the parent through the guarded runner. No model
 * turns, no Concord process, no filesystem outside the OS temp dir.
 */

const PROGRAMME_ID = "agp_0123456789ab";
const INCREMENT_ID = "inc_0123456789ab";
const REPO = "agent";

const GRANT = {
	repositories: [{ name: REPO, path: "/home/operator/project" }],
	authorizedWork: ["implementation", "review", "verification", "research", "investigation"],
	excludedExternalOperations: ["deploy"],
	acceptanceThreshold: "independent review accepts demonstrated behavior",
};

function condition(id: string) {
	return { id, statement: `agreed outcome for ${id}`, evidence: `named verification route for ${id}` };
}

const CONDITIONS = [condition("sc_scope"), condition("sc_export"), condition("sc_empty")];

function semanticsTask(overrides: Partial<TaskContractInput> = {}): TaskContractInput {
	return {
		taskId: "t_semantics",
		title: "Resolve export semantics",
		kind: "research",
		outcome: "The export filter scope and column contract are decided",
		acceptanceExamples: ["page-vs-all-records decision recorded"],
		evidence: {
			references: ["docs/list-filter.md"],
			assumptions: [{ statement: "the filter contract exists", status: "evidenced" }],
		},
		scope: { repository: REPO, files: [], exclusions: [], readOnly: true },
		dependencies: [],
		ownership: { intendedRole: "parent", reviewer: "independent review lane", writes: [] },
		verification: { checks: ["decision reviewed against the filter contract"], actor: "parent", handoffContract: "muster six-label handoff" },
		successConditions: ["sc_scope"],
		...overrides,
	};
}

function csvTask(overrides: Partial<TaskContractInput> = {}): TaskContractInput {
	return {
		taskId: "t_csv",
		title: "Implement authorized CSV generation",
		kind: "implementation",
		outcome: "The agreed query/authorization contract returns correctly escaped CSV",
		acceptanceExamples: ["empty result returns headers only", "formula-leading values are escaped"],
		evidence: {
			references: ["src/export-existing.ts"],
			assumptions: [{ statement: "server-side CSV support exists", status: "evidenced" }],
		},
		scope: { repository: REPO, files: ["src/export.ts"], exclusions: ["scheduling"], readOnly: false },
		dependencies: [{ taskId: "t_semantics", reason: "artifact", supplies: "agreed scope and columns" }],
		ownership: { intendedRole: "worker", assignedAgentId: "pi-worker-1", reviewer: "parent", writes: ["src/export.ts"] },
		verification: {
			checks: ["focused regression authored by the worker"],
			actor: "parent",
			handoffContract: "muster six-label handoff",
		},
		successConditions: ["sc_export", "sc_empty"],
		...overrides,
	};
}

function uiTask(overrides: Partial<TaskContractInput> = {}): TaskContractInput {
	return {
		taskId: "t_ui",
		title: "Add the operator export interaction",
		kind: "implementation",
		outcome: "The operator can trigger the agreed export and see busy/empty/failure states",
		acceptanceExamples: ["busy state visible while exporting"],
		evidence: {
			references: ["src/list/export-contract.md"],
			assumptions: [{ statement: "the endpoint contract is fixed by t_csv", status: "unresolved" }],
		},
		scope: { repository: REPO, files: ["src/list/export-button.tsx"], exclusions: [], readOnly: false },
		dependencies: [{ taskId: "t_semantics", reason: "interface", supplies: "agreed column order" }],
		ownership: { intendedRole: "worker", reviewer: "parent", writes: ["src/list/export-button.tsx"] },
		verification: { checks: ["UI states reviewed against acceptance examples"], actor: "parent", handoffContract: "muster six-label handoff" },
		successConditions: ["sc_export"],
		...overrides,
	};
}

function integrationTask(overrides: Partial<TaskContractInput> = {}): TaskContractInput {
	return {
		taskId: "t_integrate",
		title: "Parent integration and verification",
		kind: "integration",
		outcome: "The integrated export workflow is verified end to end",
		acceptanceExamples: ["filtered/authorized output verified after integration"],
		evidence: { references: ["plan §7.1.2"], assumptions: [] },
		scope: {
			repository: REPO,
			files: ["src/export.ts", "src/list/export-button.tsx"],
			exclusions: ["scheduling", "email delivery"],
			readOnly: false,
		},
		dependencies: [
			{ taskId: "t_csv", reason: "integration", supplies: "CSV generation" },
			{ taskId: "t_ui", reason: "integration", supplies: "export interaction" },
		],
		ownership: { intendedRole: "parent", reviewer: "independent review lane", writes: ["src/export.ts", "src/list/export-button.tsx"] },
		verification: { checks: ["guarded integration batch"], actor: "parent", handoffContract: "muster six-label handoff" },
		successConditions: ["sc_export", "sc_empty"],
		...overrides,
	};
}

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 1,
		programmeId: PROGRAMME_ID,
		incrementId: INCREMENT_ID,
		goal: "Operator CSV export",
		successConditions: CONDITIONS,
		tasks: [semanticsTask(), csvTask(), uiTask(), integrationTask()],
		proposedBy: "parent-agent",
		...overrides,
	};
}

function acceptedStore(): { dir: string; store: ReturnType<typeof fileDecompositionStore>; state: DecompositionState } {
	const dir = mkdtempSync(join(tmpdir(), "agile-decomposition-"));
	const store = fileDecompositionStore(dir);
	const proposed = proposeDecompositionRevision(store, { programmeId: PROGRAMME_ID, proposal: proposal() });
	assert.equal(proposed.ok, true, `proposal must persist: ${proposed.ok ? "" : proposed.detail}`);
	const accepted = acceptDecompositionRevision(store, {
		programmeId: PROGRAMME_ID,
		expectedRevision: 1,
		review: {
			kind: "independent-planning",
			reviewerAgentId: "pi-reviewer",
			laneReference: "herdr-review-1",
			readOnly: true,
			disposition: "accepted",
			findings: ["coverage and ownership reviewed"],
		},
	});
	assert.equal(accepted.ok, true, `acceptance must persist: ${accepted.ok ? "" : accepted.detail}`);
	return { dir, store, state: accepted.state as DecompositionState };
}

function withStore<T>(fn: (store: ReturnType<typeof fileDecompositionStore>) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "agile-decomposition-"));
	try {
		return fn(fileDecompositionStore(dir));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ─── Structural validation ───────────────────────────────────────────────────

test("agile-decomposition: a coherent DAG validates and every contract gets a code-computed hash", () => {
	const validated = validateDecomposition(proposal());
	assert.equal(validated.ok, true, validated.ok ? "" : validated.errors.join("; "));
	if (!validated.ok) return;
	assert.equal(validated.proposal.tasks.length, 4);
	for (const task of validated.proposal.tasks) {
		assert.match(task.contractHash, /^[0-9a-f]{64}$/);
		assert.equal(task.contractHash, taskContractHash(task));
	}
});

test("agile-decomposition: malformed schema is rejected precisely (unknown fields, missing fields, unsafe paths)", () => {
	const missing = validateDecomposition({ ...proposal(), goal: undefined });
	assert.equal(missing.ok, false);
	if (!missing.ok) assert.ok(missing.errors.some((error) => error.includes("goal must be a non-empty string")));

	const unknown = validateDecomposition({ ...proposal(), reviewerNotes: "extra" });
	assert.equal(unknown.ok, false);
	if (!unknown.ok) assert.ok(unknown.errors.some((error) => error.includes("unknown fields: reviewerNotes")));

	const unsafe = validateDecomposition({
		...proposal(),
		tasks: [semanticsTask(), csvTask({ scope: { repository: REPO, files: ["../../etc/passwd"], exclusions: [], readOnly: false } })],
	});
	assert.equal(unsafe.ok, false);
	if (!unsafe.ok) assert.ok(unsafe.errors.some((error) => error.includes("unsafe repository-relative path")));
});

test("agile-decomposition: missing dependency references and cycles are rejected with the offending path", () => {
	const missingReference = validateDecomposition({
		...proposal(),
		tasks: [semanticsTask(), csvTask({ dependencies: [{ taskId: "t_missing", reason: "artifact", supplies: "nothing" }] })],
	});
	assert.equal(missingReference.ok, false);
	if (!missingReference.ok) {
		assert.ok(missingReference.errors.some((error) => error.includes("dependency_unknown_task: t_csv -> t_missing")));
	}

	const selfReference = validateDecomposition({
		...proposal(),
		tasks: [semanticsTask(), csvTask({ dependencies: [{ taskId: "t_csv", reason: "artifact", supplies: "itself" }] })],
	});
	assert.equal(selfReference.ok, false);
	if (!selfReference.ok) assert.ok(selfReference.errors.some((error) => error.includes("dependency_self_reference")));

	const cycle = validateDecomposition({
		...proposal(),
		tasks: [
			semanticsTask({ dependencies: [{ taskId: "t_csv", reason: "interface", supplies: "scope" }] }),
			csvTask(),
		],
	});
	assert.equal(cycle.ok, false);
	if (!cycle.ok) assert.ok(cycle.errors.some((error) => error.includes("dependency_cycle:")));
});

test("agile-decomposition: coverage and success-condition links are checked both ways", () => {
	const uncovered = validateDecomposition({
		...proposal(),
		successConditions: [...CONDITIONS, condition("sc_audit")],
	});
	assert.equal(uncovered.ok, false);
	if (!uncovered.ok) assert.ok(uncovered.errors.some((error) => error.includes("success_condition_uncovered: sc_audit")));

	const unknownLink = validateDecomposition({
		...proposal(),
		tasks: [semanticsTask({ successConditions: ["sc_nope"] }), csvTask(), uiTask(), integrationTask()],
	});
	assert.equal(unknownLink.ok, false);
	if (!unknownLink.ok) assert.ok(unknownLink.errors.some((error) => error.includes("success_condition_unknown: t_semantics -> sc_nope")));

	const withoutVerification = validateDecomposition({
		...proposal(),
		tasks: [
			semanticsTask({ verification: { checks: [], actor: "parent", handoffContract: "muster six-label handoff" } }),
			csvTask(),
			uiTask(),
			integrationTask(),
		],
	});
	assert.equal(withoutVerification.ok, false);
	if (!withoutVerification.ok) {
		assert.ok(withoutVerification.errors.some((error) => error.includes("success_condition_without_verification: sc_scope")));
	}

	const noCondition = validateDecomposition({
		...proposal(),
		tasks: [semanticsTask({ successConditions: [] }), csvTask(), uiTask(), integrationTask()],
	});
	assert.equal(noCondition.ok, false);
	if (!noCondition.ok) {
		assert.ok(noCondition.errors.some((error) => error.includes("tasks[0].successConditions must be a non-empty string array")));
	}
});

test("agile-decomposition: two writers on one shared module are rejected unless sequenced or the same owner", () => {
	const conflict = validateDecomposition({
		...proposal(),
		tasks: [
			semanticsTask(),
			csvTask(),
			uiTask({ scope: { repository: REPO, files: ["src/export.ts"], exclusions: [], readOnly: false }, ownership: { intendedRole: "worker", reviewer: "parent", writes: ["src/export.ts"] } }),
			integrationTask(),
		],
	});
	assert.equal(conflict.ok, false);
	if (!conflict.ok) assert.ok(conflict.errors.some((error) => error.includes("shared_writer_conflict: t_csv and t_ui")));

	// The integration task writes the same files as its dependencies, which is
	// sequencing, not a conflict.
	assert.equal(validateDecomposition(proposal()).ok, true);

	const sameOwner = validateDecomposition({
		...proposal(),
		tasks: [
			semanticsTask(),
			csvTask(),
			uiTask({
				scope: { repository: REPO, files: ["src/export.ts"], exclusions: [], readOnly: false },
				ownership: { intendedRole: "worker", assignedAgentId: "pi-worker-1", reviewer: "parent", writes: ["src/export.ts"] },
			}),
			integrationTask(),
		],
	});
	assert.equal(sameOwner.ok, true, sameOwner.ok ? "" : sameOwner.errors.join("; "));
});

test("agile-decomposition: a fabricated review flag or contract hash is rejected by the schema", () => {
	const fabricated = validateDecomposition({
		...proposal(),
		tasks: [{ ...semanticsTask(), reviewed: true }, csvTask(), uiTask(), integrationTask()],
	});
	assert.equal(fabricated.ok, false);
	if (!fabricated.ok) assert.ok(fabricated.errors.some((error) => error.includes("review flags (reviewed)")));

	const wrongHash = validateDecomposition({
		...proposal(),
		tasks: [{ ...semanticsTask(), contractHash: "0".repeat(64) }, csvTask(), uiTask(), integrationTask()],
	});
	assert.equal(wrongHash.ok, false);
	if (!wrongHash.ok) assert.ok(wrongHash.errors.some((error) => error.includes("contractHash does not match")));
});

// ─── Acceptance and review provenance ────────────────────────────────────────

test("agile-decomposition: an initial revision cannot be accepted by a parent-refinement review", () => {
	withStore((store) => {
		assert.equal(proposeDecompositionRevision(store, { programmeId: PROGRAMME_ID, proposal: proposal() }).ok, true);
		const refused = acceptDecompositionRevision(store, {
			programmeId: PROGRAMME_ID,
			expectedRevision: 1,
			review: {
				kind: "parent-refinement",
				reviewerAgentId: "pi-parent",
				readOnly: true,
				disposition: "accepted",
			},
		});
		assert.equal(refused.ok, false);
		if (!refused.ok) assert.equal(refused.code, "independent_review_required");
	});
});

test("agile-decomposition: acceptance is compare-and-set; a stale expected revision conflicts", () => {
	withStore((store) => {
		assert.equal(proposeDecompositionRevision(store, { programmeId: PROGRAMME_ID, proposal: proposal() }).ok, true);
		const acceptance = {
			programmeId: PROGRAMME_ID,
			expectedRevision: 1,
			review: {
				kind: "independent-planning" as const,
				reviewerAgentId: "pi-reviewer",
				laneReference: "herdr-review-1",
				readOnly: true,
				disposition: "accepted" as const,
			},
		};
		assert.equal(acceptDecompositionRevision(store, acceptance).ok, true);
		const replay = acceptDecompositionRevision(store, acceptance);
		assert.equal(replay.ok, false);
		if (!replay.ok) assert.equal(replay.code, "already_accepted");
	});
});

test("agile-decomposition: a review disposition requires a read-only governed lane and the disposition is recorded", () => {
	withStore((store) => {
		assert.equal(proposeDecompositionRevision(store, { programmeId: PROGRAMME_ID, proposal: proposal() }).ok, true);
		const refused = acceptDecompositionRevision(store, {
			programmeId: PROGRAMME_ID,
			expectedRevision: 1,
			review: {
				kind: "independent-planning",
				reviewerAgentId: "pi-reviewer",
				readOnly: true,
				disposition: "accepted",
			},
		});
		assert.equal(refused.ok, false);
		if (!refused.ok) assert.equal(refused.code, "independent_review_required");

		const changes = acceptDecompositionRevision(store, {
			programmeId: PROGRAMME_ID,
			expectedRevision: 1,
			review: {
				kind: "independent-planning",
				reviewerAgentId: "pi-reviewer",
				laneReference: "herdr-review-1",
				readOnly: true,
				disposition: "changes-required",
				findings: ["integration ownership unclear"],
			},
		});
		assert.equal(changes.ok, true);
		if (changes.ok) {
			assert.equal(changes.state.status, "proposed");
			assert.equal(changes.state.accepted, undefined);
			assert.equal(changes.state.reviews.at(-1)?.disposition, "changes-required");
		}
	});
});

// ─── Revision impact ─────────────────────────────────────────────────────────

test("agile-decomposition: revision impact invalidates only affected contracts and preserves unaffected reviews", () => {
	const { store, state, dir } = acceptedStore();
	try {
		// An acceptance-example refinement invalidates that contract's evidence.
		const revised = proposeDecompositionRevision(store, {
			programmeId: PROGRAMME_ID,
			proposal: proposal({
				tasks: [
					semanticsTask(),
					csvTask(),
					uiTask({ acceptanceExamples: ["busy state visible", "failure state explains retry"] }),
					integrationTask(),
				],
			}),
		});
		assert.equal(revised.ok, true, revised.ok ? "" : revised.detail);
		const impact = assessRevisionImpact(state.accepted!, (revised.state as DecompositionState).graph);
		assert.deepEqual(impact.changed, ["t_ui"]);
		assert.deepEqual(impact.added, []);
		assert.deepEqual(impact.removed, []);
		assert.deepEqual(impact.recontextualised, [], "an acceptance-example change does not alter the supplied interface");
		for (const taskId of ["t_semantics", "t_csv", "t_integrate"]) {
			assert.ok(impact.carriedForward.includes(taskId), `${taskId} keeps its review evidence`);
		}
		assert.equal(impact.requiresIndependentReview, true);
		assert.equal(impact.requiresOperatorDecision, false);
		// Unaffected reviews are preserved: the accepted snapshot keeps t_csv's hash.
		assert.equal(state.accepted!.reviewedHashes["t_csv"], taskContractHash(csvTask()));

		// A changed dependency interface recontextualises the dependent contract.
		const interfaceChange = proposeDecompositionRevision(store, {
			programmeId: PROGRAMME_ID,
			proposal: proposal({
				tasks: [
					semanticsTask(),
					csvTask({
						dependencies: [
							{ taskId: "t_semantics", reason: "artifact", supplies: "agreed scope, columns and ordering" },
						],
					}),
					uiTask(),
					integrationTask(),
				],
			}),
		});
		assert.equal(interfaceChange.ok, true, interfaceChange.ok ? "" : interfaceChange.detail);
		const second = assessRevisionImpact(state.accepted!, (interfaceChange.state as DecompositionState).graph);
		assert.deepEqual(second.changed, ["t_csv"]);
		assert.ok(second.recontextualised.includes("t_integrate"), "the dependent's prerequisite context changed");
		assert.ok(second.carriedForward.includes("t_semantics"));
		assert.equal(second.requiresIndependentReview, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("agile-decomposition: a prose-only refinement is parent-reviewable; adding a task is not", () => {
	const { store, state, dir } = acceptedStore();
	try {
		const prose = proposeDecompositionRevision(store, {
			programmeId: PROGRAMME_ID,
			proposal: proposal({
				tasks: [
					semanticsTask({ title: "Resolve export semantics (CSV pilot)", evidence: { references: ["docs/list-filter.md", "docs/export.md"], assumptions: [] } }),
					csvTask(),
					uiTask(),
					integrationTask(),
				],
			}),
		});
		assert.equal(prose.ok, true, prose.ok ? "" : prose.detail);
		const impact = assessRevisionImpact(state.accepted!, (prose.state as DecompositionState).graph);
		assert.ok(impact.changed.includes("t_semantics"));
		assert.equal(impact.requiresIndependentReview, false, "a non-acceptance prose refinement is parent-reviewed");

		const added = proposeDecompositionRevision(store, {
			programmeId: PROGRAMME_ID,
			proposal: proposal({
				tasks: [
					semanticsTask(),
					csvTask(),
					uiTask(),
					integrationTask(),
					{
						...semanticsTask(),
						taskId: "t_probe",
						title: "Probe retention policy",
						evidence: { references: ["docs/retention.md"], assumptions: [] },
						verification: { checks: ["retention question resolved"], actor: "parent", handoffContract: "muster six-label handoff" },
					},
				],
			}),
		});
		assert.equal(added.ok, true, added.ok ? "" : added.detail);
		const addedImpact = assessRevisionImpact(state.accepted!, (added.state as DecompositionState).graph);
		assert.ok(addedImpact.added.includes("t_probe"));
		assert.equal(addedImpact.requiresIndependentReview, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ─── Dispatch admission ──────────────────────────────────────────────────────

test("agile-decomposition: a stale accepted revision is rejected for dispatch", () => {
	const { store, state, dir } = acceptedStore();
	try {
		const proposed = proposeDecompositionRevision(store, {
			programmeId: PROGRAMME_ID,
			proposal: proposal({ tasks: [semanticsTask({ outcome: "revised outcome" }), csvTask(), uiTask()] }),
		});
		assert.equal(proposed.ok, true);
		const current = proposed.state as DecompositionState;

		const notAccepted = canDispatchTask({
			state: current,
			taskId: "t_csv",
			intent: "start",
			phase: "active",
			role: "parent",
			agentId: "pi-parent",
			grant: GRANT,
		});
		assert.equal(notAccepted.allow, false);
		if (!notAccepted.allow) assert.equal(notAccepted.code, "decomposition_revision_not_accepted");

		// Even a state whose graph equals the accepted revision rejects a caller
		// holding an older accepted revision.
		const stale = canDispatchTask({
			state,
			taskId: "t_csv",
			intent: "start",
			phase: "active",
			role: "parent",
			agentId: "pi-parent",
			acceptedRevision: 0,
			grant: GRANT,
		});
		assert.equal(stale.allow, false);
		if (!stale.allow) assert.equal(stale.code, "stale_accepted_revision");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("agile-decomposition: dispatch requires review evidence covering the exact contract hash", () => {
	const { state, dir } = acceptedStore();
	try {
		const withoutEvidence: DecompositionState = {
			...state,
			accepted: { ...state.accepted!, reviewedHashes: { ...state.accepted!.reviewedHashes, t_csv: "0".repeat(64) } },
		};
		const decision = canDispatchTask({
			state: withoutEvidence,
			taskId: "t_csv",
			intent: "start",
			phase: "active",
			role: "worker",
			agentId: "pi-worker-1",
			grant: GRANT,
			// Satisfy the predecessor so the review-evidence precondition is the
			// blocker under test, not an unrelated missing dependency state.
			taskStates: { t_semantics: { status: "complete" } },
		});
		assert.equal(decision.allow, false);
		if (!decision.allow) assert.equal(decision.code, "review_evidence_missing");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("agile-decomposition: the ready frontier honours satisfied dependencies, capacity and ownership", () => {
	const { state, dir } = acceptedStore();
	try {
		const taskStates = {
			t_semantics: { status: "complete" },
			t_csv: { status: "active", agentId: "pi-worker-1", assignedAgentId: "pi-worker-1" },
		};
		const frontier = computeReadyFrontier({ state, taskStates });
		const readyIds = frontier.ready.map((task) => task.taskId);
		assert.deepEqual(readyIds, ["t_ui"], "only the dependency-ready, unowned task is ready");
		assert.deepEqual(
			frontier.held.map((entry) => [entry.taskId, entry.code]),
			[
				["t_semantics", "task_settled"],
				["t_csv", "already_owned"],
				["t_integrate", "dependency_not_satisfied"],
			],
		);

		const capped = computeReadyFrontier({ state, taskStates, capacity: { limit: 1, inFlight: 1 } });
		assert.deepEqual(capped.ready, []);
		assert.ok(capped.held.some((entry) => entry.taskId === "t_ui" && entry.code === "capacity_held"));

		// An owner mismatch is a dispatch denial even though the dependency is ready.
		const mismatch = canDispatchTask({
			state,
			taskId: "t_csv",
			intent: "start",
			phase: "active",
			role: "worker",
			agentId: "pi-worker-9",
			taskStates: { t_semantics: { status: "complete" } },
			grant: GRANT,
		});
		assert.equal(mismatch.allow, false);
		if (!mismatch.allow) assert.equal(mismatch.reason, "wrong_owner");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("agile-decomposition: unresolved blockers and provisional tasks stay out of the frontier", () => {
	const { state, dir } = acceptedStore();
	try {
		const proposed = proposeDecompositionRevision(
			fileDecompositionStore(join(dir, "second")),
			{
				programmeId: PROGRAMME_ID,
				proposal: proposal({
					tasks: [
						semanticsTask(),
						csvTask({ uncertainty: { blocker: "authorization contract not established" } }),
						uiTask({ uncertainty: { provisional: true } }),
						integrationTask(),
					],
				}),
			},
		);
		assert.equal(proposed.ok, true, proposed.ok ? "" : proposed.detail);
		const draft = proposed.state as DecompositionState;
		const frontier = computeReadyFrontier({
			state: draft,
			taskStates: { t_semantics: { status: "complete" } },
		});
		assert.deepEqual(frontier.ready, [], "a non-accepted revision dispatches nothing");
		assert.ok(frontier.held.every((entry) => entry.code === "decomposition_not_accepted"));

		// Same graph, accepted: the blocker and the provisional task stay held.
		const store = fileDecompositionStore(join(dir, "third"));
		assert.equal(proposeDecompositionRevision(store, { programmeId: PROGRAMME_ID, proposal: proposal({
			tasks: [
				semanticsTask(),
				csvTask({ uncertainty: { blocker: "authorization contract not established" } }),
				uiTask({ uncertainty: { provisional: true } }),
				integrationTask(),
			],
		}) }).ok, true);
		const accepted = acceptDecompositionRevision(store, {
			programmeId: PROGRAMME_ID,
			expectedRevision: 1,
			review: {
				kind: "independent-planning",
				reviewerAgentId: "pi-reviewer",
				laneReference: "herdr-review-1",
				readOnly: true,
				disposition: "accepted",
			},
		});
		assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.detail);
		const frontier2 = computeReadyFrontier({
			state: accepted.state as DecompositionState,
			taskStates: { t_semantics: { status: "complete" } },
		});
		assert.ok(frontier2.held.some((entry) => entry.taskId === "t_csv" && entry.code === "unresolved_blocker"));
		assert.ok(frontier2.held.some((entry) => entry.taskId === "t_ui" && entry.code === "provisional"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ─── Jira gate ───────────────────────────────────────────────────────────────

test("agile-decomposition: a Jira-required policy without an adapter is blocked with a setup condition", () => {
	const gate = resolveBacklogSource({ kind: "jira", reference: "PIX-1" });
	assert.equal(gate.ok, false);
	if (!gate.ok) {
		assert.equal(gate.code, "jira_connector_inactive");
		assert.match(gate.setupCondition, /Jira/);
		assert.match(gate.setupCondition, /Do not substitute a local backlog/);
	}
	const local = resolveBacklogSource({ kind: "approved-plan", reference: "plans/agile-plan.md" });
	assert.equal(local.ok, true);

	const { state, dir } = acceptedStore();
	try {
		const decision = canDispatchTask({
			state,
			taskId: "t_csv",
			intent: "start",
			phase: "active",
			role: "worker",
			agentId: "pi-worker-1",
			backlogSource: { kind: "jira", reference: "PIX-1" },
			grant: GRANT,
		});
		assert.equal(decision.allow, false);
		if (!decision.allow) {
			assert.equal(decision.reason, "unsupported_lane");
			assert.equal(decision.code, "jira_connector_inactive");
			assert.match(decision.setupCondition ?? "", /Jira/);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
