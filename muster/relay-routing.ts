/**
 * Programme relay routing (D3 live transport): routes durably journaled
 * envelopes from the bridge's relay inbox into muster's deterministic paths —
 * conversation → continuation admission, pause → programme pause, status →
 * notification reply. Leaf module: the parent wiring supplies every
 * capability; nothing here reaches into session state by itself.
 *
 * Store-then-act: the muster journal row is appended before routing, so a
 * crash replays routing, and every route is idempotent by the transport's own
 * message identity. A conversation wake never bypasses admission — an
 * unadmitted wake stays queued in the control store and joins the next
 * admitted batch, so no operator message is ever lost to a busy session.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeliveryTarget } from "./types.ts";
import { RELAY_ENVELOPE_KINDS, type JournalFold, type ProgrammeNotificationTransport, type RelayEnvelope } from "./bridge.ts";
import type { RelayInboxLine } from "./bridge.ts";

export const RELAY_DRAIN_INTERVAL_MS = 10_000;

export type RelayRoutingDeps = {
	sessionId: string;
	journal: {
		fold(): Promise<{ deliveries: Map<string, unknown> }>;
		append(record: unknown): unknown;
	};
	listEnrollments(): ReadonlyArray<{ programmeId: string; status: string }>;
	inboxPathFor(programmeId: string): string;
	notifyDegraded(scope: string, message: string): void;
	pauseProgramme(programmeId: string, operatorRef: string): void;
	/** Operator off from the bound thread: revoke execution authorization + release the binding. */
	stopProgramme(programmeId: string, operatorRef: string): void;
	formatStatusText(): string;
	sendProgrammeNotification(
		programmeId: string,
		notification: { kind: string; text: string },
	): Promise<unknown>;
	/** One admission attempt for an operator conversation (returns never throws). */
	admitConversation(
		programmeId: string,
		platformMessageId: string,
		body: string,
	): Promise<"admitted" | "queued" | "rejected">;
	/** Deliver the admitted continuation prompt into the session; throws to fail the claim. */
	deliverConversationPrompt(envelope: RelayEnvelope): Promise<void>;
	failAdmittedClaim(platformMessageId: string): void;
	transport: () => ProgrammeNotificationTransport;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRelayEnvelope(value: unknown): value is RelayEnvelope {
	if (!isPlainObject(value)) return false;
	if (typeof value.programmeId !== "string" || value.programmeId === "") return false;
	if (typeof value.platformMessageId !== "string" || value.platformMessageId === "") return false;
	// Validate against the bridge's canonical kind list: a hand-rolled subset here
	// silently dropped `off` (and `decision-answer`) envelopes at the drain gate
	// even though the router below knows how to apply them.
	if (typeof value.kind !== "string" || !(RELAY_ENVELOPE_KINDS as readonly string[]).includes(value.kind)) return false;
	if (typeof value.actorId !== "string" || value.actorId === "") return false;
	if (typeof value.body !== "string") return false;
	return true;
}

export function relayTransportTarget(configPath: string): string | undefined {
	try {
		const raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
		if (!isPlainObject(raw) || raw.schemaVersion !== 1) return undefined;
		const target = raw.target;
		return typeof target === "string" && /^[a-z0-9]+:\S+$/.test(target) ? target : undefined;
	} catch {
		return undefined;
	}
}

/** Route one durable relay envelope; returns true when a route was taken. */
export async function routeRelayEnvelope(deps: RelayRoutingDeps, envelope: RelayEnvelope): Promise<boolean> {
	const { journal } = deps;
	const fold = await journal.fold();
	const deliveryKey = `relay/${envelope.programmeId}/${envelope.platformMessageId}`;
	if (fold.deliveries.has(deliveryKey)) return false;
	const target: DeliveryTarget = {
		kind: "programme-relay",
		programmeId: envelope.programmeId,
		envelopeKind: envelope.kind,
		platformMessageId: envelope.platformMessageId,
		actorId: envelope.actorId,
		body: envelope.body,
	};
	journal.append({
		type: "delivery",
		record: {
			type: "pending",
			deliveryKey,
			repoKey: "",
			sessionId: deps.sessionId,
			target,
			payload: envelope.body,
			at: new Date().toISOString(),
		},
	});
	if (envelope.kind === "pause") {
		try {
			deps.pauseProgramme(envelope.programmeId, `relay:${envelope.actorId}`);
		} catch (error) {
			deps.notifyDegraded("programme-relay", `pause not applied: ${String((error as Error)?.message ?? error)}`);
		}
	} else if (envelope.kind === "off") {
		// Messages sent while off are never queued for later execution; the off
		// itself is an explicit operator action, so it applies immediately.
		try {
			deps.stopProgramme(envelope.programmeId, `relay:${envelope.actorId}`);
		} catch (error) {
			deps.notifyDegraded("programme-relay", `off not applied: ${String((error as Error)?.message ?? error)}`);
		}
	} else if (envelope.kind === "status") {
		try {
			await deps.sendProgrammeNotification(envelope.programmeId, {
				kind: "status",
				text: `muster status (requested from the bound thread):\n${deps.formatStatusText()}`,
			});
		} catch (error) {
			deps.notifyDegraded("programme-relay", `status not sent: ${String((error as Error)?.message ?? error)}`);
		}
	} else {
		let delivered = false;
		try {
			const admission = await deps.admitConversation(envelope.programmeId, envelope.platformMessageId, envelope.body);
			if (admission === "admitted") {
				try {
					await deps.deliverConversationPrompt(envelope);
					delivered = true;
				} catch (error) {
					deps.failAdmittedClaim(envelope.platformMessageId);
					throw error;
				}
			}
		} catch (error) {
			deps.notifyDegraded("programme-relay", `conversation not admitted: ${String((error as Error)?.message ?? error)}`);
		}
		// "recorded" must mean the prompt actually reached the session. A failed or
		// queued delivery stays pending: the durable key still dedupes re-routing
		// ticks, and the restart reconciler replays unrecorded deliveries.
		if (!delivered) return false;
	}
	journal.append({
		type: "delivery",
		record: {
			type: "recorded",
			deliveryKey,
			sessionEntryId: `relay:${envelope.platformMessageId}`,
			at: new Date().toISOString(),
		},
	});
	return true;
}

/**
 * Drain the relay inboxes of every enrolled programme (D3): bounded read of the
 * append-only inbox files, one journal-recorded routing per envelope.
 * Non-enrolled programmes are left untouched — the durable inbox keeps the
 * envelopes until a session that can route them runs.
 */
export async function drainProgrammeRelay(deps: RelayRoutingDeps): Promise<number> {
	const enrollments = deps.listEnrollments();
	if (enrollments.length === 0) return 0;
	const seen = new Set(enrollments.map((entry) => entry.programmeId));
	let routed = 0;
	for (const programmeId of seen) {
		const inboxPath = deps.inboxPathFor(programmeId);
		if (!existsSync(inboxPath)) continue;
		let raw: string;
		try {
			raw = readFileSync(inboxPath, "utf8");
		} catch (error) {
			deps.notifyDegraded("programme-relay", `relay inbox unreadable: ${String((error as Error)?.message ?? error)}`);
			continue;
		}
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (trimmed === "") continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				// Torn/foreign line: never blocks legitimate envelopes.
				continue;
			}
			const envelope = (parsed as { envelope?: unknown } | null)?.envelope;
			if (!isRelayEnvelope(envelope) || envelope.programmeId !== programmeId) continue;
			if (envelope.kind === "decision-answer") continue; // applied synchronously by the socket server
			await routeRelayEnvelope(deps, envelope);
			routed += 1;
		}
	}
	return routed;
}

export type { RelayInboxLine };
