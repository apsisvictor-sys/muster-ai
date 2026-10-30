import "./muster-test-isolation.ts";
/**
 * TICKALERT (spec §4, OL3b): a red core unit raises the prepared ask and is never restarted, while every
 * other red unit keeps the once-a-day restart the tick already makes.
 *
 * The tick's repair step is the one owner of what a red contract causes. The table marks the two units whose
 * restart is not the tick's to make (`contracts.ts` `autoRestart: false`, Henry relay 2026-10-28 21:12 (f)):
 * their red state is the alert - the unit, since when it has shown no proof, and the one command that restarts
 * it - and nothing in this pass runs it. Everything else is unchanged: one restart per contract per day, one
 * ask per `askCode`.
 *
 * Every test runs against an OS temp state directory with a fake repair port, so nothing here restarts a unit,
 * reads the live doctor result or writes the machine's ask store. Authored here; executed through `./test.sh`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REPAIRS_FILE, REPAIR_ASK_DELAY_MS, contractStep, localDate, readRepairs } from "../health/contract-asks.ts";
import type { ContractOutcome, ContractRow, ContractState, ContractWriter } from "../health/contract-asks.ts";
import { CONTRACT_TABLE, SERVICE_IDS } from "../health/contracts.ts";
import { readAsks, type Ask } from "../asks.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** 12:00 Sofia: far from a day boundary, so the once-a-day rule is the only thing a clock difference can trip. */
const T0 = Date.parse("2026-10-28T10:00:00.000Z");

/** A time as the alert writes it: the local day and clock, computed here as the reader's own expectation. */
function stamp(ms: number): string {
	const d = new Date(ms);
	return `${localDate(ms)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** One contract row as the doctor publishes it: the fields this step reads, and nothing more. */
function row(id: string, state: ContractState, reason?: string, extra: Partial<ContractRow> = {}): ContractRow {
	return { kind: "service", id, state, ok: state === "green", ...(reason === undefined ? {} : { reason }), ...extra };
}

type Lab = { dir: string; repairs: string[][]; outcomes: ContractOutcome[][] };

async function withLab(run: (lab: Lab) => void | Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "muster-contract-alert-"));
	const lab: Lab = { dir, repairs: [], outcomes: [] };
	try {
		await run(lab);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** One pass with the fake repair port: nothing here reaches a service. */
async function pass(
	lab: Lab,
	input: { at: number; rows: readonly ContractRow[]; writer?: ContractWriter },
): Promise<ContractOutcome[]> {
	const outcomes = await contractStep({
		writer: input.writer ?? "tick",
		stateDir: lab.dir,
		now: input.at,
		rows: input.rows,
		repair: (argv) => {
			lab.repairs.push([...argv]);
			return { ok: true, detail: "ran" };
		},
	});
	lab.outcomes.push(outcomes);
	return outcomes;
}

function liveAsks(dir: string, code: string): Ask[] {
	return readAsks(dir).asks.filter((ask) => ask.code === code && (ask.status === "open" || ask.status === "awaiting-operator"));
}

/** The two units whose restart the table refuses the tick: the ledger daemon and the gateway. */
const CORE_UNITS = [
	{ id: SERVICE_IDS.ledger, unit: "musterd.service", code: CONTRACT_TABLE[SERVICE_IDS.ledger]!.askCode },
	{ id: SERVICE_IDS.gateway, unit: "muster-gateway.service", code: CONTRACT_TABLE[SERVICE_IDS.gateway]!.askCode },
] as const;

test("alert: a red core unit raises its one prepared ask and the tick never restarts it", async () => {
	await withLab(async (lab) => {
		const proofAt = T0 - 40 * MINUTE;
		const rows = CORE_UNITS.map((core) =>
			row(core.id, "red", "last proof 40 min ago, past its fresh 20 min", { proofAt: new Date(proofAt).toISOString() }),
		);

		const outcomes = await pass(lab, { at: T0, rows });
		assert.deepEqual(lab.repairs, [], "no argv is run for a core unit, whatever its state");
		assert.deepEqual(readRepairs(lab.dir), {}, "and no attempt is recorded, because none was made");
		assert.equal(outcomes.filter((outcome) => outcome.action === "repaired").length, 0, "nothing reports a restart");
		assert.equal(
			outcomes.filter((outcome) => outcome.action === "repair-skipped").length,
			CORE_UNITS.length,
			"each core unit says why it was not restarted, once",
		);

		for (const core of CORE_UNITS) {
			const asked = liveAsks(lab.dir, core.code);
			assert.equal(asked.length, 1, `${core.id} raises its ask at once, not 15 minutes after a repair that never runs`);
			const question = asked[0]!.question;
			assert.match(question, new RegExp(`^${core.id} is red: `), "the alert says the unit is red");
			assert.ok(question.includes(`no proof since ${stamp(proofAt)}`), "and since when, from the doctor's own last proof");
			assert.ok(
				question.includes(`systemctl --user restart ${core.unit}`),
				"and the one command that restarts it, as the table declares it",
			);
			const options = asked[0]!.options;
			assert.equal(options.length, 3, "the alert is fully prepared: options and a recommendation");
			assert.equal(
				options.filter((option) => option.includes(`systemctl --user restart ${core.unit}`)).length,
				1,
				"one option is the restart the tick did not make",
			);
			assert.equal(asked[0]!.recommendation, options[0], "the recommendation is one of them");
			assert.equal(asked[0]!.raisedBy, "tick", "the tick writes the alert in its own name");
			assert.equal(asked[0]!.owner, CONTRACT_TABLE[core.id]!.owner, "routed to the contract's own owner");
		}

		// One ask per `askCode`, and nothing repeated: the second pass the same day is silent.
		const again = await pass(lab, { at: T0 + 2 * MINUTE, rows });
		assert.deepEqual(again, [], "a pass with the alert already open reports nothing");
		for (const core of CORE_UNITS) assert.equal(liveAsks(lab.dir, core.code).length, 1, `${core.id}: one ask, not two`);
		assert.deepEqual(lab.repairs, [], "and still no restart");
	});
});

test("alert: a core unit whose proof is gone says since when from the doctor's own first-seen time", async () => {
	await withLab(async (lab) => {
		const pendingSince = T0 - 3 * HOUR;
		const outcomes = await pass(lab, {
			at: T0,
			rows: [row(SERVICE_IDS.ledger, "red", "no proof in its first 20 min", { pendingSince: new Date(pendingSince).toISOString() })],
		});
		assert.deepEqual(lab.repairs, []);
		assert.deepEqual(outcomes.map((outcome) => outcome.action), ["repair-skipped", "ask-raised"]);
		const asked = liveAsks(lab.dir, CONTRACT_TABLE[SERVICE_IDS.ledger]!.askCode)[0]!;
		assert.ok(asked.question.includes(`no proof since ${stamp(pendingSince)}`), "the pending time stands in for the last proof");
	});
});

test("restart: a red unit that is not one of the two core units keeps its once-a-day restart", async () => {
	await withLab(async (lab) => {
		const rows = [row("pi-doctor.timer", "red", "last proof 40 min ago, past its fresh 10 min")];

		const first = await pass(lab, { at: T0, rows });
		assert.deepEqual(lab.repairs, [["systemctl", "--user", "restart", "pi-doctor.timer"]], "the declared restart runs, as today");
		assert.deepEqual(first.map((outcome) => outcome.action), ["repaired"]);
		assert.deepEqual(JSON.parse(readFileSync(join(lab.dir, REPAIRS_FILE), "utf8")), { "pi-doctor.timer": T0 }, "the attempt is recorded");
		assert.deepEqual(liveAsks(lab.dir, CONTRACT_TABLE["pi-doctor.timer"]!.askCode), [], "nothing is asked inside the 15-minute wait");

		const waiting = await pass(lab, { at: T0 + REPAIR_ASK_DELAY_MS - 1, rows });
		assert.deepEqual(waiting, [], "still inside the wait");
		await pass(lab, { at: T0 + REPAIR_ASK_DELAY_MS, rows });
		assert.equal(liveAsks(lab.dir, CONTRACT_TABLE["pi-doctor.timer"]!.askCode).length, 1, "then one ask, as today");
		assert.equal(lab.repairs.length, 1, "one restart per contract per day");

		await pass(lab, { at: T0 + 24 * HOUR, rows });
		assert.equal(lab.repairs.length, 2, "and the next day's pass restarts it again");
	});
});

test("table: the marker is declared on exactly the two core units, and every other contract leaves the restart to the tick", () => {
	const declared = Object.entries(CONTRACT_TABLE)
		.filter(([, declaration]) => declaration.autoRestart === false)
		.map(([id]) => id)
		.sort();
	assert.deepEqual(declared, [SERVICE_IDS.gateway, SERVICE_IDS.ledger].sort(), "no name is hard-coded in the repair step");
	for (const id of declared) {
		const declaration = CONTRACT_TABLE[id]!;
		assert.equal(declaration.onRed.action, "repair", "what the tick may not do is run this row's declared command");
		if (declaration.onRed.action === "repair") {
			assert.match(declaration.onRed.command, /^systemctl --user restart \S+\.service$/, "and the alert quotes that command, as one restart of the unit itself");
		}
	}
	for (const [id, declaration] of Object.entries(CONTRACT_TABLE)) {
		if (declared.includes(id)) continue;
		assert.notEqual(declaration.autoRestart, false, `${id} keeps the tick's own restart`);
	}
});
