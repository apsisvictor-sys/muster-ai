/**
 * The Muster ledger's vocabulary: the session-scoped document families, the
 * event entry kind, and the type of every record the ledger stores. One owner.
 */

import type { EntryId, JsonObject } from "@earendil-works/pi-durable";
import { defineDocFamily, defineEntry } from "@earendil-works/pi-durable";
// Type-only: `asks.ts` is the owner of the ask's vocabulary, and this file keeps
// the record verbatim (LC-D3). The import is erased, so no module cycle is created.
import type { AskEvent } from "../asks.ts";
// Type-only, the same rule: `lib/agent-inbox.ts` owns the message's vocabulary and
// this file stores its record verbatim (§2.1). Erased, so the module cycle with the
// owner's ledger client does not exist at runtime.
import type { InboxMessage } from "../lib/agent-inbox.ts";

/**
 * One compare-and-set record. An owner's record goes in verbatim (LC-D3): the
 * seat rules stay in `extensions/muster/seats.ts`, the lane card's rules in
 * `extensions/lib/lane-card.ts`.
 */
export type CasDoc = {
	record: JsonObject | null;
	revision: number;
};

/** The first result of one request id, so a repeated request returns it and writes nothing. */
export type RequestDoc = {
	eventAt: number;
	result: JsonObject;
};

/** Session metadata: the live tick's task id. Key `tick`. */
export type MetaDoc = {
	tickId: string | null;
};

/**
 * One ask to the operator (LD37): its queue events in append order. Key `ask` id; the
 * fold that turns them into a status is `asks.ts`'s, unchanged, and an appended
 * event posts no `muster.event` entry.
 */
export type AskDoc = {
	events: AskEvent[];
};

/**
 * One message: the owner's record verbatim plus its delivery state (§2.1). Key is
 * the message id, so the two backends answer `findInboxMessage` from one record.
 * Delivered messages are kept, as `read/` keeps them today, and never grow the
 * address's index document.
 */
export type MessageDoc = {
	address: string;
	message: InboxMessage;
	state: "accepted" | "delivered";
	deliveredAt: number | null;
};

/** One address's undelivered message ids, in arrival order (§2.1). Key is the address. */
export type InboxDoc = {
	pending: string[];
};

/** A ledger event: the entry lines `muster wait` reads, replacing `orchestrator-events.log` and `send-log.jsonl`. */
export type MusterEventValue = {
	type: string;
	lane?: string;
	text: string;
	at: number;
	requestId?: string;
};

/** A committed event with its entry id. The id is the event cursor, never `at`, so two events in one millisecond are both read. */
export type MusterEventData = MusterEventValue & { id: EntryId };

export const MusterEvent = defineEntry<MusterEventValue>("muster.event");

export const CasFamily = defineDocFamily<CasDoc, { store?: string; id?: string }>({
	kind: "muster.cas",
	version: 1,
	family: true,
	scope: "session",
	initial: () => ({ record: null, revision: 0 }),
});

export const AskFamily = defineDocFamily<AskDoc, { askId?: string }>({
	kind: "muster.ask",
	version: 1,
	family: true,
	scope: "session",
	initial: () => ({ events: [] }),
});

/**
 * The document kinds a subscriber can be woken by (CRP, blueprint D30 first part):
 * a compare-and-set write of any owner store (`CasFamily` above, key `<store>:<id>`)
 * and an ask append (`AskFamily`, key the ask id). Named once here, beside the two
 * families whose `kind` it spells, so no subscriber types the literal and a later
 * document family adds its kind in this one place.
 */
export type LedgerDocKind = "muster.cas" | "muster.ask";

export const MessageFamily = defineDocFamily<MessageDoc, { id?: string }>({
	kind: "muster.message",
	version: 1,
	family: true,
	scope: "session",
	// `send` writes every field of the document it creates; this is what one holds
	// between `tx.doc` and those writes, and what `drain`/`markDelivered` read.
	initial: () => ({ address: "", message: { id: "", agent: "", from: "", at: "", text: "", idempotencyKey: "" }, state: "accepted", deliveredAt: null }),
});

export const InboxFamily = defineDocFamily<InboxDoc, { address?: string }>({
	kind: "muster.inbox",
	version: 1,
	family: true,
	scope: "session",
	initial: () => ({ pending: [] }),
});

export const RequestFamily = defineDocFamily<RequestDoc, { requestId?: string }>({
	kind: "muster.request",
	version: 1,
	family: true,
	scope: "session",
	initial: () => ({ eventAt: 0, result: {} }),
});

export const MetaFamily = defineDocFamily<MetaDoc, { key?: string }>({
	kind: "muster.meta",
	version: 1,
	family: true,
	scope: "session",
	initial: () => ({ tickId: null }),
});

/** `MetaFamily`'s one key. */
export const META_TICK_KEY = "tick";
