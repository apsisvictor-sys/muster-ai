/**
 * Pi's half of the Muster seats (WP-S3, seats blueprint 2026-10-12, LD20 to LD24).
 *
 * The seat owner (`seats.ts`) decides who holds a seat. This adapter only turns what
 * happens in a Pi session into calls on that owner:
 * - the operator's typed phrase claims a seat. Pi stamps every input with its source, and only
 *   `interactive` (the Pi TUI in a terminal, tmux or herdr) counts. The check and the claim
 *   happen in this process, so no ticket is needed.
 * - The credential goes into this process's environment, which Pi's bash tool inherits.
 * - A holder keeps `lastTypedAt` fresh, and learns from its own credential when the seat moved.
 * - Which inbox this session polls follows the seat it holds.
 * - An assignment written for this session (LD36) is adopted on its next input, through the owner's
 *   claim with the assignment's nonce. A session that already holds a seat leaves the file alone.
 *
 * Nothing here keeps seat state of its own: the record in `seats.ts` is the authority, and the
 * session's token is the only thing remembered between calls.
 */

import {
	SEAT_ENV_ROLE,
	SEAT_ENV_TOKEN,
	SEAT_ROLES,
	SeatStateError,
	authorizeSeatActor,
	claimSeat,
	readSeat,
	readSeatAssignment,
	rebindSeat,
	resolveSeatRole,
	seatHeldBy,
	seatOf,
	touchSeat,
	type SeatContext,
	type SeatProof,
	type SeatRole,
} from "./seats.ts";

/** `/seat <role>` or "become the <role>" at the start of the text, as the blueprint's phrase rule reads it. */
const SEAT_PHRASE = /^\s*(?:\/seat\s+(orchestrator|architect|designer)|become the (orchestrator|architect|designer))\b/i;

/** `lastTypedAt` is written at most once a minute (blueprint, Adapters). */
export const SEAT_TYPED_TOUCH_INTERVAL_MS = 60_000;

/** The seat a typed phrase asks for, or undefined when the text is not the phrase. */
export function seatPhrase(text: string): SeatRole | undefined {
	const match = SEAT_PHRASE.exec(text);
	const name = match?.[1] ?? match?.[2];
	return name === undefined ? undefined : resolveSeatRole(name);
}

export type PiSeatSession = { sessionId: string; processKey: string; transcript?: string };

export type PiSeatAdapterOptions = {
	/** The running session, or undefined before `session_start`. */
	session: () => PiSeatSession | undefined;
	/** Where the seat files live and how the owner reads the clock and process table. */
	seats?: SeatContext;
	/** The environment the credential goes into. Default: this process's. */
	env?: NodeJS.ProcessEnv;
	now?: () => number;
};

export type SeatInputResult = {
	/** The text to hand on to the model, or undefined when it is unchanged. */
	text?: string;
	/** The held seat changed (claimed, refused over a held one, or lost): the poll and status line need a refresh. */
	changed: boolean;
};

type HeldSeat = { role: SeatRole; token: string; epoch: number };

/**
 * What the adapter tells the model when it takes a seat.
 *
 * WAKE1 (2026-10-29): the orchestrator seat no longer arms anything. `muster-orch-waker` (the systemd
 * user unit) blocks on the seat's events and inbox and delivers into the session, so a holder that
 * remembered `scripts/orch-wait.sh` would be starting a second reader of the same inbox.
 */
function claimContext(role: SeatRole, epoch: number, dossier: readonly string[]): string {
	const wake = `This session polls the ${role} inbox itself. A message sent to \`${role}\` reaches this seat. The session id is the process, not the mailbox. Arm nothing.`;
	return `[Muster seat] You now hold the ${role} seat (#${epoch}). Read your dossier first: ${dossier.join(", ")}. ${wake}`;
}

export class PiSeatAdapter {
	private held: HeldSeat | undefined;
	private lastTouchMs = Number.NEGATIVE_INFINITY;
	private pendingNotice: string | undefined;

	constructor(private readonly options: PiSeatAdapterOptions) {}

	private get env(): NodeJS.ProcessEnv {
		return this.options.env ?? process.env;
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	/** The seat this session holds, if any. */
	current(): { role: SeatRole; epoch: number } | undefined {
		return this.held === undefined ? undefined : { role: this.held.role, epoch: this.held.epoch };
	}

	/** `◆ orchestrator #8`, the same line the Claude status line prints. Undefined when no seat is held. */
	statusText(): string | undefined {
		return this.held === undefined ? undefined : `◆ ${this.held.role} #${this.held.epoch}`;
	}

	private setEnv(held: HeldSeat | undefined): void {
		if (held === undefined) {
			delete this.env[SEAT_ENV_ROLE];
			delete this.env[SEAT_ENV_TOKEN];
			return;
		}
		this.env[SEAT_ENV_ROLE] = held.role;
		this.env[SEAT_ENV_TOKEN] = held.token;
	}

	/**
	 * Does the owner still accept this session's credential? When it does not, the seat moved (LD22):
	 * the credential and the environment are dropped and the model is told once, on its next input.
	 */
	reconcile(): boolean {
		const held = this.held;
		if (held === undefined) return false;
		try {
			const decision = authorizeSeatActor(held.role, held.token, this.options.seats);
			if (decision.allowed && decision.reason === "holder") return false;
			this.pendingNotice = `[Muster seat] You no longer hold the ${held.role} seat (#${held.epoch}, now #${decision.epoch}). ${this.lossActor(held.role)} Stay open as an ordinary session and send any handover notes with \`muster send ${held.role} "HANDOVER: …"\`.`;
		} catch {
			// An unreadable seat file is not proof the seat moved: keep the credential.
			return false;
		}
		this.held = undefined;
		this.setEnv(undefined);
		return true;
	}

	/** Who the loss notice names as the mover: the new holder's `assignedBy` (LD36). */
	private lossActor(role: SeatRole): string {
		try {
			const assignedBy = readSeat(role, this.options.seats).holder?.assignedBy;
			if (assignedBy === "shell") return "the operator moved it by assignment from his shell.";
			if (assignedBy === "gateway") return "the operator moved it by assignment through the gateway.";
		} catch {
			// An unreadable seat file keeps the default wording below.
		}
		return "the operator moved it from his terminal.";
	}

	/**
	 * Called for every input the session receives. A phrase typed at the terminal claims the seat;
	 * the same phrase from any other source claims nothing. A holder's terminal-typed input keeps
	 * `lastTypedAt` fresh. An assignment addressed to this session (LD36) is adopted on any input.
	 */
	onInput(source: string | undefined, text: string): SeatInputResult {
		let changed = this.reconcile();
		const notes: string[] = [];
		if (this.pendingNotice !== undefined) {
			notes.push(this.pendingNotice);
			this.pendingNotice = undefined;
		}
		const role = typeof text === "string" ? seatPhrase(text) : undefined;
		if (role !== undefined && source === "interactive") {
			const outcome = this.claim(role, { kind: "in-process" });
			notes.push(outcome.note);
			changed ||= outcome.changed;
		} else if (role !== undefined && source === "rpc") {
			notes.push("[Muster seat] Seats move only when the operator types the phrase at a terminal at the PC, tmux or herdr. This arrived over rpc, so no seat moved.");
		} else if (source === "interactive") {
			this.touchTyped();
		}
		changed = this.adoptAssignment(notes) || changed;
		return { changed, ...(notes.length > 0 ? { text: `${text}\n\n${notes.join("\n")}` } : {}) };
	}

	/**
	 * LD36: an assignment written for this session is taken on the input that follows it. A session
	 * that already holds a seat leaves the file for the assigner's ten minutes: its environment
	 * carries one credential, and a claim over a held seat is one the owner would refuse.
	 */
	private adoptAssignment(notes: string[]): boolean {
		if (this.held !== undefined) return false;
		const session = this.options.session();
		if (session === undefined) return false;
		for (const role of SEAT_ROLES) {
			const assignment = readSeatAssignment(role, this.options.seats);
			if (assignment?.sessionId !== session.sessionId) continue;
			const outcome = this.claim(role, { kind: "assignment", nonce: assignment.nonce });
			notes.push(outcome.note);
			return outcome.changed;
		}
		return false;
	}

	/** Take the seat through the owner: the phrase typed in this process, or an assignment's nonce (LD36). */
	private claim(role: SeatRole, proof: SeatProof): { note: string; changed: boolean } {
		const session = this.options.session();
		if (session === undefined) return { note: `[Muster seat] The ${role} seat was not claimed: this session is not ready yet. Ask the operator to type the phrase again.`, changed: false };
		if (this.held !== undefined && this.held.role !== role) {
			return {
				note: `[Muster seat] The ${role} seat was not claimed: this session already holds the ${this.held.role} seat, and its environment carries one credential. Ask the operator to give that seat up first.`,
				changed: false,
			};
		}
		// A lane id that is a seat name would send the previous-holder notice into the seat's own inbox.
		const agent = this.env.CONCORD_AGENT_ID?.trim();
		const laneId = agent !== undefined && agent !== "" && resolveSeatRole(agent) === undefined ? agent : undefined;
		try {
			const claimed = claimSeat(
				role,
				{ harness: "pi", sessionId: session.sessionId, processKey: session.processKey, ...(laneId !== undefined ? { laneId } : {}), ...(session.transcript !== undefined ? { transcript: session.transcript } : {}) },
				proof,
				this.options.seats,
			);
			this.held = { role, token: claimed.token, epoch: claimed.epoch };
			this.setEnv(this.held);
			this.touch();
			return { note: claimContext(role, claimed.epoch, readSeat(role, this.options.seats).dossier), changed: true };
		} catch (error) {
			const why = error instanceof SeatStateError ? error.message : String((error as Error)?.message ?? error);
			return { note: `[Muster seat] The ${role} seat was not claimed: ${why}`, changed: false };
		}
	}

	private touch(): void {
		const held = this.held;
		if (held === undefined) return;
		this.lastTouchMs = this.now();
		try {
			touchSeat(held.role, held.token, this.options.seats);
		} catch {
			// A refusal means the seat moved; the next reconcile says so. Any other failure must not break the input.
		}
	}

	private touchTyped(): void {
		if (this.held === undefined || this.now() - this.lastTouchMs < SEAT_TYPED_TOUCH_INTERVAL_MS) return;
		this.touch();
	}

	/**
	 * `session_start`. A seat this session already holds (the same session id) is picked up again:
	 * from the environment when this is the process that holds it (a reload), by rebinding when it
	 * is a new process for a holder whose old process is gone. A credential in the environment that
	 * does not belong to this session (a child of a holder) is dropped, so no session but the holder acts as the seat.
	 */
	restore(): void {
		this.held = undefined;
		this.pendingNotice = undefined;
		const session = this.options.session();
		const inherited = { role: resolveSeatRole(this.env[SEAT_ENV_ROLE] ?? ""), token: this.env[SEAT_ENV_TOKEN] };
		try {
			if (session !== undefined) {
				for (const role of seatOf(session.sessionId, this.options.seats)) {
					const record = readSeat(role, this.options.seats);
					const epoch = record.epoch;
					if (inherited.role === role && inherited.token !== undefined) {
						const decision = authorizeSeatActor(role, inherited.token, this.options.seats);
						if (decision.allowed && decision.reason === "holder") {
							this.held = { role, token: inherited.token, epoch };
							break;
						}
					}
					if (record.holder?.processKey !== session.processKey) {
						const rebound = rebindSeat(
							role,
							{ harness: "pi", sessionId: session.sessionId, processKey: session.processKey, ...(session.transcript !== undefined ? { transcript: session.transcript } : {}), ...(record.holder?.laneId !== undefined ? { laneId: record.holder.laneId } : {}) },
							{ kind: "in-process" },
							this.options.seats,
						);
						this.held = { role, token: rebound.token, epoch: rebound.epoch };
						break;
					}
				}
			}
		} catch {
			// A rebind the owner refuses (its old process still runs) leaves this session an ordinary one.
		}
		this.setEnv(this.held);
	}

	/**
	 * The inbox this session polls. A seat polls its role name (`orchestrator`, `architect`), never the
	 * holder's session id or lane id. The session id is the process. Mail sent to the role stays in that
	 * inbox when the seat moves. A session that holds no seat keeps the legacy rule only while the
	 * orchestrator seat was never claimed (epoch 0).
	 */
	pollAgent(agentId: string | undefined): string | undefined {
		this.reconcile();
		if (this.held !== undefined) return this.held.role;
		if (seatHeldBy(agentId, this.options.seats) !== "orchestrator") return undefined;
		try {
			if (readSeat("orchestrator", this.options.seats).epoch !== 0) return undefined;
		} catch {
			// An unreadable seat file leaves today's behaviour.
		}
		return agentId?.trim();
	}
}
