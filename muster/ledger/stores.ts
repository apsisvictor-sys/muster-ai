/**
 * The ledger's owner stores (LC5, §2.1): one constant per record family, and the
 * one place an owner resolves `musterd`'s socket.
 *
 * A store name is the `(store, id)` key of the ledger's compare-and-set family
 * (`CasFamily`, `schema.ts`); the record stored under it is the owner's own
 * record, verbatim (LC-D3). One name, exported once, so no caller types a string
 * literal and a rename breaks the build rather than the store.
 */

import { ledgerSocketPath } from "./cas-store.ts";
import { musterStateDir } from "../binding.ts";

/** The lane card store: id = lane id, record = `LaneCard` (`lib/lane-card.ts:82`). */
export const LANE_CARD_STORE = "lane-card";
/** The lane record store: id = lane id, record = `LaneRecord` (`lane-lifecycle.ts`). */
export const LANE_RECORD_STORE = "lane-record";
/** The launcher's registry: id = lane id, record = the `pi-lanes.json` row. */
export const LANE_REGISTRY_STORE = "lane-registry";
/** The lane control queue: one request per lane, id = lane id (`lib/lane-control.ts`). */
export const LANE_CONTROL_STORE = "lane-control";
/** Programme continuation control: id = programme id, record = `ProgrammeControlRecord` (`control.ts`). */
export const PROGRAMME_CONTROL_STORE = "programme-control";
/** The goal registry: id = the goal's two-capital-letter code, record = `GoalRecord` (`goals.ts`). */
export const GOAL_STORE = "goal";
/** The work-item registry: id = the item's code, record = `WorkItemRecord` (`work-items.ts`, spec §7a). */
export const WORK_ITEM_STORE = "work-item";
/** The research desk: one record, id `desk`, record = `DeskRecord` (`research-desk.ts`). */
export const DESK_STORE = "research-desk";

/**
 * Where `musterd` serves the ledger socket: inside `MUSTER_LEDGER_DIR` when set,
 * else the Muster state directory. That is the rule `ledger/open.ts:ledgerDir`
 * owns, read here the way `seats.ts` reads it, because importing that module
 * would pull Durable Pi into the one-file Claude hook bundle (DL4).
 */
export function ownerLedgerSocket(stateDir: string = musterStateDir()): string {
	const override = process.env["MUSTER_LEDGER_DIR"]?.trim();
	return ledgerSocketPath(override !== undefined && override !== "" ? override : stateDir);
}
