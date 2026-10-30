/**
 * A delivery that reached this session's inbox becomes a turn (WAKE-DELIVERY, 2026-10-29).
 *
 * `inbox-wake.ts` owns reading the inbox and `muster-orch-waker` owns writing the
 * wake; neither of them starts a turn. Before this module the inbox poll handed each
 * message to the shared event transport, which sent it as a custom message — and the
 * orchestrator seat's holder polled no inbox at all, so a wake written and reported
 * `delivered` never started a turn (22:49 and 23:05 on 2026-10-29).
 *
 * This is the extension's own half: the session's turn lifecycle.
 *
 * - A delivery while the session is idle is injected as user input, so the turn starts
 *   at once. The inbox poll runs every few seconds, well inside `WAKE_BUDGET_MS`.
 * - A delivery while a turn runs waits in the queue. It is injected only from the turn
 *   boundary (`boundary()` on `agent_settled`), and then with `deliverAs: "followUp"`,
 *   so a running tool call never receives it.
 * - One drain is one injection: deliveries that arrive together are one turn, and the
 *   injected text names every delivery it carries.
 * - Nothing is consumed on the strength of the injection alone. A receipt is written,
 *   and the inbox message is marked read, only when the session's own turn starts
 *   (`turnStarted()` on `agent_start`). Until then the delivery stays unread and in
 *   place, so the waker's next delivery and the operator both still see it.
 * - A delivery whose turn does not start inside `WAKE_BUDGET_MS` is recorded as a missed
 *   wake (`outcome: "missed"`, `waitedMs`), not as a quiet pass. It is still held for a
 *   late turn, and that late turn's receipt carries `missedBeforeTurn: true` with its own
 *   latency, so a reader can see both the miss and the delay that caused it.
 * - Both clocks are kept, and the budget is judged on the one the waker promised: delivery
 *   to turn (`deliveryLatencyMs`, from the message's own write time). A slow poll that
 *   still turns inside the minute passes; a fast poll whose turn is late is a miss even
 *   though the injection waited only seconds. `injectionLatencyMs` is recorded beside it,
 *   so a reader can tell a late poll from a late turn.
 *
 * Admission is not re-expressed here: the caller passes the installed Muster wake
 * policy's `admit`, the same one the event transport consults, so the operator's pause,
 * the kill file, the breaker and the editor/prompt holds still decide.
 */

import type { EventWakeRequest } from "../core/event-wake.ts";
import type { InboxMessage } from "./lib/agent-inbox.ts";

/** The waker's promise: an idle seat turns inside a minute. Asserted by the tests as a real interval. */
export const WAKE_BUDGET_MS = 60_000;

/** One delivery waiting for its turn: the producer's request and the inbox message behind it. */
export type WakeInjection = { request: EventWakeRequest; message: InboxMessage };

/**
 * One line of evidence per delivery.
 *
 * `started` is the wake: the session's turn began, so the delivery was acted on. `missed`
 * is the wake that did not happen inside the budget — written instead of a receipt, so a
 * stalled injection can never read as a delivered one.
 */
export type WakeInjectionReceipt = {
	outcome: "started" | "missed";
	messageId: string;
	/** The inbox address the message was written to (the seat's own). */
	agent: string;
	from: string;
	/** ISO time the sender wrote it: the clock the 60-second budget is measured from. */
	deliveredAt: string;
	/** Epoch ms when this session injected the delivery. */
	injectedAt: number;
	/** Epoch ms when the turn that carried it started (`outcome: "started"`). */
	turnStartedAt?: number;
	/** `turnStartedAt - deliveredAt` (`outcome: "started"`): the contract, delivery to turn. */
	deliveryLatencyMs?: number;
	/** `turnStartedAt - injectedAt` (`outcome: "started"`): how long the injection itself waited. */
	injectionLatencyMs?: number;
	/** `now - deliveredAt` when the miss was recorded (`outcome: "missed"`): the delivery clock again. */
	waitedMs?: number;
	/** The budget the wake was judged against. */
	budgetMs: number;
	/** `idle`: the injection started the turn; `boundary`: the next boundary applied it. */
	appliedAs: "idle" | "boundary";
	/** How many deliveries this one turn carried. */
	batch: number;
	/** Set on a `started` line whose injection had already been reported missed. */
	missedBeforeTurn?: boolean;
};

export type WakeInjectionPorts = {
	/** The session's own idle state (`ctx.isIdle()`). */
	isIdle: () => boolean;
	/** The Pi SDK's injection: a user message, queued at the boundary when a run is active. */
	inject: (text: string, options: { deliverAs: "followUp" }) => void;
	/** Durable evidence: the turn that started, or the budget that passed without one. */
	record: (receipt: WakeInjectionReceipt) => void;
	/** The clock the receipts are stamped with, and the clock the budget is judged against. */
	now: () => number;
	/** The wake policy's admission. Absent means no permission to wake, so the delivery is held. */
	admit?: (request: EventWakeRequest) => boolean;
	/** The policy's own release for a delivery that could not be injected. */
	sendFailed?: (request: EventWakeRequest, error: unknown) => void;
	/** The producer's own completion: the inbox message is read only after the turn started. */
	onInjected?: (message: InboxMessage) => void;
};

/**
 * The clock the waker's promise is judged on: the delivery's own write time, never the poll's.
 * A stamp that does not parse falls back to the injection; the record still carries it as written,
 * so a reader can see which clock was used.
 */
function judgedFrom(delivery: WakeInjection, injection: Injection): number {
	const written = Date.parse(delivery.message.at);
	return Number.isFinite(written) ? written : injection.injectedAt;
}

/** One injection and the deliveries it carried, held until the turn it started is seen. */
type Injection = {
	deliveries: WakeInjection[];
	injectedAt: number;
	appliedAs: "idle" | "boundary";
	missedReported: boolean;
};

/** The one injected text of a drain: every delivery it carries, named by id. */
export function wakeInjectionText(batch: readonly WakeInjection[]): string {
	const header =
		batch.length === 1
			? "Muster wake: one delivery reached this session's inbox."
			: `Muster wake: ${batch.length} deliveries reached this session's inbox together.`;
	const body = batch.map(({ message, request }) => `--- inbox message ${message.id} from ${message.from} at ${message.at} ---\n${request.text.trim()}`);
	return [header, ...body, "", "Act on these deliveries now."].join("\n");
}

function factsOf(delivery: WakeInjection): Pick<WakeInjectionReceipt, "messageId" | "agent" | "from" | "deliveredAt"> {
	return { messageId: delivery.message.id, agent: delivery.message.agent, from: delivery.message.from, deliveredAt: delivery.message.at };
}

export class WakeInjector {
	private readonly queue = new Map<string, WakeInjection>();
	/** Injected, waiting for the turn to prove itself. */
	private readonly awaiting = new Map<string, { injection: Injection; delivery: WakeInjection }>();
	/** Deliveries whose turn was seen: never injected again. */
	private readonly started = new Set<string>();
	private scheduled = false;
	private closed = false;

	constructor(private readonly ports: WakeInjectionPorts) {}

	get pendingCount(): number {
		return this.queue.size;
	}

	/** Injected and still waiting for its turn: the deliveries a stall would otherwise consume. */
	get awaitingCount(): number {
		return this.awaiting.size;
	}

	/**
	 * A delivery the inbox poll just read. It is queued and the drain is coalesced to the
	 * current microtask, so a poll pass that reads two messages injects them as one turn.
	 * A delivery already injected and awaiting its turn is a duplicate: it stays in place,
	 * unread, until that turn starts.
	 */
	deliver(request: EventWakeRequest, message: InboxMessage): "queued" | "duplicate" | "closed" {
		if (this.closed) return "closed";
		if (this.started.has(message.id) || this.awaiting.has(message.id)) {
			this.reportMisses();
			return "duplicate";
		}
		if (!this.queue.has(message.id)) this.queue.set(message.id, { request, message });
		this.reportMisses();
		this.schedule();
		return "queued";
	}

	/**
	 * A turn boundary passed. Everything waiting is injected now: the session is between
	 * turns, and `deliverAs: "followUp"` keeps Pi's own queue in charge if it is settling.
	 */
	boundary(): number {
		this.reportMisses();
		return this.flush();
	}

	/**
	 * The session's own turn started (`agent_start`): every delivery injected before it has
	 * demonstrably been acted on, so this is where the receipt is written and the inbox
	 * message is marked read. Returns how many deliveries it settled.
	 */
	turnStarted(): number {
		if (this.awaiting.size === 0) return 0;
		const startedAt = this.ports.now();
		const settled = [...this.awaiting.values()];
		this.awaiting.clear();
		for (const { injection, delivery } of settled) {
			this.started.add(delivery.message.id);
			this.record({
				outcome: "started",
				...factsOf(delivery),
				injectedAt: injection.injectedAt,
				turnStartedAt: startedAt,
				deliveryLatencyMs: startedAt - judgedFrom(delivery, injection),
				injectionLatencyMs: startedAt - injection.injectedAt,
				budgetMs: WAKE_BUDGET_MS,
				appliedAs: injection.appliedAs,
				batch: injection.deliveries.length,
				...(injection.missedReported ? { missedBeforeTurn: true } : {}),
			});
			try {
				this.ports.onInjected?.(delivery.message);
			} catch {
				/* the producer owns its own durable evidence */
			}
		}
		return settled.length;
	}

	/** Judge every waiting injection against the budget. Called on each poll pass and boundary. */
	misses(): number {
		return this.reportMisses();
	}

	close(): void {
		this.closed = true;
		this.queue.clear();
		this.awaiting.clear();
	}

	private record(receipt: WakeInjectionReceipt): void {
		try {
			this.ports.record(receipt);
		} catch {
			/* the turn is already started; evidence that cannot be written must not undo it */
		}
	}

	private schedule(): void {
		if (this.scheduled || this.closed) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			if (this.isIdle()) this.flush();
		});
	}

	/** A session that cannot answer the idle question is treated as running: the delivery waits for the boundary. */
	private isIdle(): boolean {
		try {
			return this.ports.isIdle();
		} catch {
			return false;
		}
	}

	private reportMisses(): number {
		if (this.awaiting.size === 0) return 0;
		const now = this.ports.now();
		const due = new Map<Injection, WakeInjection[]>();
		for (const { injection, delivery } of this.awaiting.values()) {
			if (injection.missedReported) continue;
			// Delivery to turn, not injection to turn: a slow poll does not borrow time from the budget.
			if (now - judgedFrom(delivery, injection) < WAKE_BUDGET_MS) continue;
			const list = due.get(injection) ?? [];
			list.push(delivery);
			due.set(injection, list);
		}
		let missed = 0;
		for (const [injection, deliveries] of due) {
			injection.missedReported = true;
			for (const delivery of deliveries) {
				missed += 1;
				this.record({
					outcome: "missed",
					...factsOf(delivery),
					injectedAt: injection.injectedAt,
					waitedMs: now - judgedFrom(delivery, injection),
					budgetMs: WAKE_BUDGET_MS,
					appliedAs: injection.appliedAs,
					batch: injection.deliveries.length,
				});
			}
		}
		return missed;
	}

	private flush(): number {
		if (this.closed || this.queue.size === 0) return 0;
		const batch: WakeInjection[] = [];
		for (const [id, delivery] of [...this.queue]) {
			let admitted = true;
			try {
				if (this.ports.admit !== undefined) admitted = this.ports.admit(delivery.request);
			} catch {
				// A policy that cannot judge a delivery holds it, exactly as a missing policy does.
				admitted = false;
			}
			if (!admitted) continue;
			batch.push(delivery);
			this.queue.delete(id);
		}
		if (batch.length === 0) return 0;
		const idle = this.isIdle();
		try {
			this.ports.inject(wakeInjectionText(batch), { deliverAs: "followUp" });
		} catch (error) {
			for (const delivery of batch) {
				this.queue.set(delivery.message.id, delivery);
				try {
					this.ports.sendFailed?.(delivery.request, error);
				} catch {
					/* a policy that cannot release a claim must not lose the delivery */
				}
			}
			return 0;
		}
		const injection: Injection = { deliveries: batch, injectedAt: this.ports.now(), appliedAs: idle ? "idle" : "boundary", missedReported: false };
		for (const delivery of batch) this.awaiting.set(delivery.message.id, { injection, delivery });
		return batch.length;
	}
}
