import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	attachProgramme,
	claimContinuation,
	fileProgrammeControlStore,
	type OwnerFence,
	ownerFenceSatisfied,
	type ProgrammeControlContext,
	type ProgrammeControlStore,
	pauseProgramme,
	readProgrammeSnapshot,
} from "../control.ts";

import {
	resolveEnrolledProgramme,
	resolveProgrammeBootAuthority,
} from "../control-bridge.ts";

import { fileCasStore } from "../owner-fence.ts";

const programmeId = "agp_0000000000ef";
const sessionId = "saved-session";
const processKey = "pi-101-boot-123";
const fence = { sessionId, processKey, epoch: 1 };

function isolated(
	run: (
		ctx: ProgrammeControlContext & { store: ProgrammeControlStore },
	) => void,
): void {
	const dir = mkdtempSync(
		join(process.env.TMPDIR ?? tmpdir(), "muster-fence-"),
	);
	try {
		run({
			store: fileProgrammeControlStore(dir),
			killFilePath: join(dir, "disabled"),
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("owner fence binds the physical process, session and epoch; incomplete fences deny", () => {
	const owner = { ...fence, leaseExpiresAt: new Date(0).toISOString() };
	assert.equal(ownerFenceSatisfied(owner, fence), true);
	assert.equal(
		ownerFenceSatisfied(owner, { ...fence, processKey: "pi-202-boot-999" }),
		false,
	);
	assert.equal(
		ownerFenceSatisfied(owner, { ...fence, sessionId: "other-session" }),
		false,
	);
	assert.equal(ownerFenceSatisfied(owner, { ...fence, epoch: 2 }), false);
	assert.equal(
		ownerFenceSatisfied(owner, { sessionId, epoch: 1 } as OwnerFence),
		false,
	);
});

test("a different physical process of the same saved session is an audited takeover", () => {
	isolated((ctx) => {
		attachProgramme(
			programmeId,
			{ sessionId, processKey, operatorRef: "operator" },
			ctx,
		);
		const next = attachProgramme(
			programmeId,
			{
				sessionId,
				processKey: "pi-202-boot-999",
				operatorRef: "operator",
			},
			ctx,
		);
		assert.equal(next.takeover, true);
		assert.equal(next.owner.epoch, 2);
		const action = readProgrammeSnapshot(programmeId, ctx).operatorActions.at(
			-1,
		);
		assert.equal(action?.operatorRef, "operator");
		assert.equal(action?.reason, `ownership takeover from ${sessionId}`);
		assert.deepEqual(claimContinuation(programmeId, sessionId, ctx, fence), {
			outcome: "denied",
			reason: "ownership-lost",
		});
	});
});

test("post-claim reread rejects a takeover immediately after the claim commit without erasing evidence", () => {
	isolated((ctx) => {
		attachProgramme(
			programmeId,
			{ sessionId, processKey, operatorRef: "operator" },
			ctx,
		);
		const underlying = ctx.store;
		let transferred = false;
		const interleaved: ProgrammeControlStore = {
			...underlying,
			update(id, revision, mutate) {
				const committed = underlying.update(id, revision, mutate);
				if (!transferred && committed.activeClaim !== null) {
					transferred = true;
					attachProgramme(
						programmeId,
						{
							sessionId: "replacement",
							processKey: "pi-202-boot-999",
							operatorRef: "operator",
						},
						ctx,
					);
				}
				return committed;
			},
		};
		assert.deepEqual(
			claimContinuation(
				programmeId,
				sessionId,
				{ ...ctx, store: interleaved },
				fence,
			),
			{
				outcome: "denied",
				reason: "ownership-lost",
			},
		);
		const stored = readProgrammeSnapshot(programmeId, ctx);
		assert.equal(stored.owner?.sessionId, "replacement");
		assert.equal(stored.activeClaim?.sessionRef, sessionId);
	});
});

test("physical-process enrolment rejects another process of the same saved session", () => {
	isolated((ctx) => {
		attachProgramme(
			programmeId,
			{ sessionId, processKey, operatorRef: "operator" },
			ctx,
		);
		const bridgeCtx = { ...ctx, controlDir: ctx.store.dir, processKey };
		assert.equal(
			resolveEnrolledProgramme(sessionId, bridgeCtx)?.ownerProcessKey,
			processKey,
		);
		assert.equal(
			resolveEnrolledProgramme(sessionId, {
				...bridgeCtx,
				processKey: "pi-202-boot-999",
			}),
			undefined,
		);
	});
});

for (const previousProcessKey of ["pi-101-boot", "pi-202-boot-999"]) {
	test(`boot reports operator reattach for mismatched process ${previousProcessKey} without taking authority`, () => {
		isolated((ctx) => {
			attachProgramme(
				programmeId,
				{ sessionId, processKey: previousProcessKey, operatorRef: "operator" },
				ctx,
			);
			const before = readProgrammeSnapshot(programmeId, ctx);
			assert.deepEqual(
				resolveProgrammeBootAuthority(sessionId, processKey, {
					...ctx,
					controlDir: ctx.store.dir,
				}),
				{
					outcome: "reattach-required",
					programmeId,
					command: `/muster on ${programmeId}`,
				},
			);
			assert.deepEqual(readProgrammeSnapshot(programmeId, ctx), before);
		});
	});
}

test("boot resolves a matching physical owner read-only, including paused state", () => {
	isolated((ctx) => {
		attachProgramme(
			programmeId,
			{ sessionId, processKey, operatorRef: "operator" },
			ctx,
		);
		const bridge = { ...ctx, controlDir: ctx.store.dir };
		pauseProgramme(programmeId, "operator paused", ctx, fence);
		const before = readProgrammeSnapshot(programmeId, ctx);
		assert.equal(before.status, "paused");
		const ready = resolveProgrammeBootAuthority(sessionId, processKey, bridge);
		assert.equal(ready.outcome, "ready");
		assert.deepEqual(readProgrammeSnapshot(programmeId, ctx), before);
		assert.deepEqual(
			resolveProgrammeBootAuthority("foreign-session", processKey, bridge),
			{ outcome: "not-enrolled" },
		);
	});
});

test("a valid fence cannot authorize a claim for a different session reference", () => {
	isolated((ctx) => {
		attachProgramme(
			programmeId,
			{ sessionId, processKey, operatorRef: "operator" },
			ctx,
		);
		assert.deepEqual(
			claimContinuation(programmeId, "foreign-session", ctx, fence),
			{
				outcome: "denied",
				reason: "ownership-lost",
			},
		);
		assert.equal(readProgrammeSnapshot(programmeId, ctx).activeClaim, null);
	});
});

test("fileCasStore keeps a caller's file layout, message noun and pass-through refusal", () => {
	const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "muster-cas-"));
	try {
		type Probe = { revision: number; value: string };
		class ProbeStoreError extends Error {
			code: "missing" | "malformed" | "conflict" | "io";
			constructor(code: "missing" | "malformed" | "conflict" | "io", message: string) {
				super(message);
				this.name = "ProbeStoreError";
				this.code = code;
			}
		}
		class ProbeRefusal extends Error {}
		const store = fileCasStore<Probe>({
			dir,
			idPattern: /^agp_[0-9a-f]{12}$/,
			idKind: "programme",
			noun: "programme decisions",
			recordNoun: "file",
			fileName: (id) => join(dir, `${id}.decisions.json`),
			validate: (raw) => {
				const value = raw as { revision?: unknown; value?: unknown };
				if (typeof value.revision !== "number" || typeof value.value !== "string") {
					return { ok: false, errors: ["probe record must carry revision and value"] };
				}
				return { ok: true, record: { revision: value.revision, value: value.value } };
			},
			errorClass: ProbeStoreError,
			passThrough: (error) => error instanceof ProbeRefusal,
		});
		store.update(programmeId, undefined, () => ({ revision: 1, value: "first" }));
		assert.equal(existsSync(join(dir, `${programmeId}.decisions.json`)), true);
		assert.equal(store.read(programmeId)?.value, "first");
		assert.throws(
			() => store.update(programmeId, 2, (current) => current as Probe),
			(error: unknown) => (error as { code?: string }).code === "conflict",
		);
		assert.throws(
			() =>
				store.update(programmeId, 1, () => {
					throw new ProbeRefusal("keep me");
				}),
			(error: unknown) => error instanceof ProbeRefusal && error.message === "keep me",
		);
		// `put` is create-or-replace (LC18): the stored revision is not asked for, the write
		// lands, and the revision rises above whatever was stored.
		assert.deepEqual(store.put(programmeId, { value: "second" }), { revision: 2, value: "second" });
		assert.equal(store.read(programmeId)?.value, "second");
		// A record that does not exist yet is created by the same call.
		assert.deepEqual(store.put("agp_ffffffffffff", { value: "third" }), { revision: 1, value: "third" });
		assert.equal(store.read("agp_ffffffffffff")?.value, "third");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
