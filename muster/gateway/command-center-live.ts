/**
 * The command center's live hub (command center blueprint Revision 7, D30 second part, D31).
 *
 * One hub per gateway process serves every connected page. While at least one page is connected it
 * holds one ledger subscription (document wakes and the event kinds), maps each wake to the panels it
 * changes, composes only those through the composer's own functions, and sends a panel only when its
 * `data` or `error` changed. `readAt` changes on every read and is left out of the hash (S2), so a
 * panel that was re-read but did not change is not resent.
 *
 * Every frame is shaped by the listener that opened the stream and then redacted: the hub never writes
 * a frame itself, it hands the data to the subscriber's own `shape`, which is `redactDeep(shapeState(…))`
 * on both listeners (`command-center.ts`). One implementation for the tailnet page and the PC page.
 *
 * The ping is an event and not an SSE comment, because `EventSource` never surfaces comment lines and
 * the page's offline timer counts every event (Q5). A quiet stream therefore never reads as offline.
 *
 * The clocks run only while a page is connected. `tick()` is public and driven by one timer in
 * production and by the test's own clock, so the floors, the 300 ms compose delay and the 25 s ping are
 * measured rather than waited for.
 */

import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";

import { EVENT_KINDS } from "../lane-report.ts";
import { LANE_STAGE_LABELS, LANE_STAGE_SENT_BACK } from "../lane-stage.ts";
import { createClient } from "../ledger/client.ts";
import { readBackend } from "../ledger/backend.ts";
import { ownerLedgerSocket } from "../ledger/stores.ts";
import type { ComposedPanels, CommandCenterState, PanelResult } from "./command-center.ts";

// ─── Panels ────────────────────────────────────────────────────────────────

/** Every panel the composer can build: today's keys plus the three D30 adds. */
export const PANEL_NAMES = ["summary", "lanes", "machine", "decisions", "delivery", "goals", "team", "shipped", "next", "ideas", "pendingPc", "messages", "activity", "usage", "contracts", "history"] as const;
export type PanelName = (typeof PANEL_NAMES)[number];

/**
 * How often each panel is recomposed at least, whatever the wakes (D30's clocks): every panel has a
 * 60 s floor, the machine 30 s, and activity, messages and the PC actions 15 s.
 */
export const PANEL_FLOOR_MS: Record<PanelName, number> = {
	summary: 60_000,
	lanes: 60_000,
	machine: 30_000,
	decisions: 60_000,
	delivery: 60_000,
	goals: 60_000,
	team: 60_000,
	shipped: 60_000,
	next: 60_000,
	ideas: 60_000,
	pendingPc: 15_000,
	messages: 15_000,
	activity: 15_000,
	usage: 60_000,
	contracts: 60_000,
	history: 60_000,
};

/**
 * The panels that are not recomposed more often than this, however many wakes arrive: a lane card is
 * rewritten on every heartbeat, so a card write marks `activity` at most once in 15 s (CRH 2).
 */
export const PANEL_MIN_GAP_MS: Partial<Record<PanelName, number>> = { activity: 15_000, messages: 15_000, pendingPc: 15_000 };

/** The first compose after a wake, and the closest two composes may be (D30). */
export const COMPOSE_DELAY_MS = 300;
export const MIN_COMPOSE_GAP_MS = 1_000;
/** A page's stream ends after 30 minutes and the browser reconnects through the listener's checks again. */
export const STREAM_LIFETIME_MS = 30 * 60_000;
/** The ping frame, so a quiet stream never reads as offline. */
export const PING_MS = 25_000;
/**
 * The most a page may leave unread in its socket before it is dropped. A page behind a tunnel that stopped
 * forwarding never reads, and every frame written to it sat in the process until its 30 minutes were up: with
 * the browser reconnecting every 5 s, that was gigabytes. Dropping it lets the browser reconnect cleanly.
 */
export const MAX_UNREAD_BYTES = 1_000_000;
/** At most this many pages at once; the oldest is closed to make room. */
export const MAX_SUBSCRIBERS = 16;
/** Ledger's rollback mode (the files backend): no subscription exists, so the hub reads every panel this often. */
export const FILE_MODE_POLL_MS = 10_000;

/**
 * Which panels one tick composes (D30's clocks, F6c): every panel past its own floor, plus every woken panel that
 * is outside its gap. A woken panel inside its gap is `held` — its wake survives the compose, because a compose
 * that only serves the panels that happened to be due is not the read it was waiting for.
 */
export function duePanels(input: {
	lastRead: ReadonlyMap<PanelName, number>;
	pending: Iterable<PanelName>;
	woken: boolean;
	nowMs: number;
	/** The tables, overridable so the rule can be pinned without waiting 15 seconds for it. */
	floorMs?: Readonly<Record<PanelName, number>>;
	gapMs?: Readonly<Partial<Record<PanelName, number>>>;
}): { due: PanelName[]; held: PanelName[] } {
	const floorMs = input.floorMs ?? PANEL_FLOOR_MS;
	const gapMs = input.gapMs ?? PANEL_MIN_GAP_MS;
	const due = new Set<PanelName>();
	const held: PanelName[] = [];
	const gapOf = (name: PanelName): number => gapMs[name] ?? 0;
	for (const name of PANEL_NAMES) {
		const since = input.nowMs - (input.lastRead.get(name) ?? 0);
		// A panel inside a 15 s gap waits for it too: a floor never breaks the gap its wakes keep.
		if (since >= floorMs[name] && since >= gapOf(name)) due.add(name);
	}
	if (input.woken) {
		for (const name of input.pending) {
			if (input.nowMs - (input.lastRead.get(name) ?? 0) >= gapOf(name)) due.add(name);
			else held.push(name);
		}
	}
	return { due: [...due], held };
}

/** One wake the hub reacts to. `poll` is the files backend's own clock. */
export type LiveWake = { kind: "doc"; docKind: string; key: string } | { kind: "event"; type: string } | { kind: "reconnect" } | { kind: "poll" };

const ALL_PANELS: readonly PanelName[] = PANEL_NAMES;

/**
 * The D30 table: which panels a wake changes. A lane record and its registry row move the board and
 * everything built on it; a lane card only `activity`, because the card is rewritten on every
 * heartbeat; a goal moves `lanes` too, because a lane's goal and station come from the goal registry.
 */
export function panelsForWake(wake: LiveWake): PanelName[] {
	if (wake.kind === "reconnect" || wake.kind === "poll") return [...ALL_PANELS];
	if (wake.kind === "event") return ["lanes", "summary"];
	if (wake.docKind === "muster.ask") return ["decisions", "goals", "summary"];
	// A compare-and-set key is `<store>:<id>` (ledger/methods.ts): the store is the part before the colon.
	const store = wake.key.slice(0, Math.max(0, wake.key.indexOf(":")));
	switch (store) {
		case "lane-record":
		case "lane-registry":
			return ["lanes", "goals", "summary", "next", "shipped"];
		case "lane-card":
			return ["activity"];
		case "goal":
			return ["goals", "lanes", "next", "shipped", "summary"];
		case "research-desk":
			return ["ideas"];
		default:
			return [];
	}
}

// ─── Change lines (D31) ────────────────────────────────────────────────────

const QUESTION_CHARS = 80;
const OPERATOR_WRITERS: readonly string[] = ["operator-shell", "operator-page"];

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** One line per change a compose made, in the words the operator reads (D31). Deterministic order. */
export function diffStates(previous: CommandCenterState | undefined, next: CommandCenterState): string[] {
	const lines: string[] = [];
	// A state that does not carry a panel has not changed it: the compare is between the rows it does carry.
	const before = previous?.panels.lanes?.data?.rows ?? [];
	const after = next.panels.lanes?.data?.rows ?? [];
	if (previous === undefined || before !== after) {
		const known = new Map(before.map((row) => [row.laneId, row]));
		for (const row of after) {
			const title = row.title !== "" ? row.title : row.laneId;
			const model = row.modelName ?? row.model ?? null;
			const was = known.get(row.laneId);
			if (was === undefined) {
				// A lane that appeared: its first line, with the model it started on when one is known.
				lines.push(model === null ? `${title} started.` : `${title} started on ${model}.`);
				continue;
			}
			if (was.stage === row.stage && was.health === row.health) continue;
			if (row.stage === "merged" && was.stage !== "merged") lines.push(`${title} merged.`);
			else if (was.stage !== row.stage) {
				const round = row.stage === LANE_STAGE_SENT_BACK ? `, fix round ${row.rounds > 0 ? row.rounds : 1}` : "";
				lines.push(`${title} moved to ${LANE_STAGE_LABELS[row.stage]}${round}.`);
			}
			if (row.health === "stalled" && was.health !== "stalled") lines.push(`${title} is stalled.`);
		}
	}

	const ticketsBefore = new Set((previous?.panels.decisions?.data?.tickets ?? []).map((ticket) => ticket.id));
	for (const ticket of next.panels.decisions?.data?.tickets ?? []) {
		if (ticketsBefore.has(ticket.id)) continue;
		lines.push(`New decision: ${truncate(ticket.question, QUESTION_CHARS)}.`);
	}
	const settledBefore = new Set((previous?.panels.decisions?.data?.settledToday ?? []).map((entry) => entry.id));
	for (const entry of next.panels.decisions?.data?.settledToday ?? []) {
		if (settledBefore.has(entry.id)) continue;
		const code = entry.code;
		// D31, S8: his own answer or a seat's relay of his words is his; a seat answering alone is not.
		const his = entry.by !== null && OPERATOR_WRITERS.includes(entry.by) ? true : entry.relay;
		lines.push(his ? `You answered ${code}.` : `${code} answered.`);
	}

	const finishedBefore = new Set<string>();
	for (const group of previous?.panels.goals?.data?.groups ?? []) {
		for (const goal of group.goals) for (const station of goal.stations) if (station.done) finishedBefore.add(`${goal.code}/${station.id}`);
	}
	for (const group of next.panels.goals?.data?.groups ?? []) {
		for (const goal of group.goals) {
			for (const station of goal.stations) {
				if (!station.done || finishedBefore.has(`${goal.code}/${station.id}`)) continue;
				lines.push(`${station.name} finished on ${goal.name}.`);
			}
		}
	}
	return lines;
}

// ─── The hub ───────────────────────────────────────────────────────────────

export type LiveFrame = { event: "state" | "panels" | "ping"; data: unknown };

export type LiveHubOptions = {
	/** The whole state, as the state route returns it. */
	state: () => Promise<CommandCenterState>;
	/** The composer's one implementation, over the panels named. */
	composePanels: (names: ReadonlySet<PanelName>) => Promise<ComposedPanels>;
	now?: () => Date;
	/** Where wakes come from while a page is connected; absent means the files backend and its poll clock. */
	subscribe?: (onWake: (wake: LiveWake) => void) => (() => void) | undefined;
};

type Subscriber = {
	id: number;
	res: ServerResponse;
	shape: (value: unknown) => unknown;
	openedAt: number;
	lastFrameAt: number;
	/** What this page was last sent, per panel: a second page's first frame cannot overwrite the first page's baseline. */
	hashes: Map<PanelName, string>;
};

/** What one listener hands the hub: the response and its own shape (redactDeep over its shapeState). */
export type LiveOpener = (res: ServerResponse, shape: (value: unknown) => unknown) => void;

export type LiveHub = {
	/** Serve one page's stream until it closes or its 30 minutes are up. */
	open: LiveOpener;
	/** One clock step: pings, lifetimes, floors and the wakes that are due. Driven by a timer, or a test's own clock. */
	tick: () => Promise<void>;
	/** The newest change lines, newest last, at most 20 (the state frame carries them as `recent`). */
	recentChanges: () => string[];
	/** How many pages are connected; the subscription exists only while this is above zero. */
	subscriberCount: () => number;
	close: () => void;
};

const hashOf = (panel: PanelResult<unknown> | undefined): string | undefined =>
	panel === undefined ? undefined : createHash("sha1").update(JSON.stringify({ data: panel.data, error: panel.error })).digest("hex");

export function createLiveHub(options: LiveHubOptions): LiveHub {
	const now = options.now ?? (() => new Date());
	const subscribers = new Map<number, Subscriber>();
	const lastRead = new Map<PanelName, number>();
	const pending = new Set<PanelName>();
	const recent: string[] = [];
	let current: CommandCenterState | undefined;
	let nextId = 1;
	let composeAt: number | null = null;
	let lastComposeAt = 0;
	let lastFilePollAt = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let unsubscribe: (() => void) | undefined;
	/**
	 * Which clock this connection runs on (F2): `unknown` until the subscription is attempted, `ledger` when it
	 * returned a closer, `files` when it returned nothing. The composer always passes a function, and on the files
	 * backend that function has nothing to subscribe to, so `undefined` from it is the files backend.
	 */
	let mode: "unknown" | "ledger" | "files" = "unknown";
	let composing: Promise<void> | undefined;

	/** The panel a name reads from a state: `summary` is its own key, the rest sit under `panels`. */
	const panelOf = (state: CommandCenterState, name: PanelName): PanelResult<unknown> | undefined =>
		name === "summary" ? state.summary : (state.panels as Record<string, PanelResult<unknown>>)[name];

	const write = (sub: Subscriber, event: LiveFrame["event"], data: unknown): boolean => {
		if (sub.res.writableEnded || sub.res.destroyed) {
			detach(sub);
			return false;
		}
		if (sub.res.writableLength > MAX_UNREAD_BYTES) {
			// A page that stopped reading: drop it rather than buffer for it.
			detach(sub);
			sub.res.destroy();
			return false;
		}
		// Every frame, the ping included, goes through the listener's own shape: one path, no exemption to keep in mind.
		sub.res.write(`event: ${event}\ndata: ${JSON.stringify(sub.shape(data))}\n\n`);
		sub.lastFrameAt = now().getTime();
		return true;
	};

	const detach = (sub: Subscriber): void => {
		subscribers.delete(sub.id);
		if (subscribers.size === 0) {
			unsubscribe?.();
			unsubscribe = undefined;
			mode = "unknown";
			lastFilePollAt = 0;
			if (timer !== undefined) clearInterval(timer);
			timer = undefined;
			pending.clear();
			composeAt = null;
		}
	};

	const ensureClocks = (): void => {
		if (timer !== undefined && mode !== "unknown") return;
		if (mode === "unknown") {
			const off = options.subscribe?.(wake);
			if (off === undefined) mode = "files";
			else {
				mode = "ledger";
				unsubscribe = off;
			}
		}
		timer ??= setInterval(() => {
			void hub.tick();
		}, 1_000);
		timer.unref?.();
	};

	const wake = (signal: LiveWake): void => {
		const panels = panelsForWake(signal);
		if (panels.length === 0) return;
		for (const name of panels) pending.add(name);
		const at = now().getTime();
		composeAt = Math.max(at + COMPOSE_DELAY_MS, lastComposeAt === 0 ? 0 : lastComposeAt + MIN_COMPOSE_GAP_MS);
	};

	/** The state as it stands, merged with a compose's panels. */
	const merge = (composed: ComposedPanels): CommandCenterState => {
		const base = current;
		const panels = { ...(base?.panels ?? {}), ...composed.panels } as CommandCenterState["panels"];
		const summary = composed.summary ?? base?.summary;
		return {
			generatedAt: now().toISOString(),
			startedAt: base?.startedAt ?? now().toISOString(),
			...(summary !== undefined ? { summary } : {}),
			panels,
			...(base?.stages !== undefined ? { stages: base.stages } : {}),
			recent: [...recent],
		} as CommandCenterState;
	};

	const composeDue = async (): Promise<void> => {
		if (subscribers.size === 0) return;
		const nowMs = now().getTime();
		const opened = subscribers.size > 0;
		if (!opened) return;
		const woken = composeAt !== null && nowMs >= composeAt;
		const { due, held } = duePanels({ lastRead, pending, woken, nowMs });
		const names = new Set<PanelName>(due);
		if (names.size === 0) return;
		if (lastComposeAt !== 0 && nowMs - lastComposeAt < MIN_COMPOSE_GAP_MS) return;
		if (woken) {
			pending.clear();
			for (const name of held) pending.add(name);
			composeAt = held.length === 0 ? null : nowMs + MIN_COMPOSE_GAP_MS;
		}
		lastComposeAt = nowMs;
		const composed = await options.composePanels(names);
		for (const name of names) lastRead.set(name, nowMs);

		const next = merge(composed);
		const nextHashes = new Map<PanelName, string>();
		const panelsOfNext = new Map<PanelName, PanelResult<unknown>>();
		for (const name of names) {
			const panel = panelOf(next, name);
			const hash = hashOf(panel);
			if (hash === undefined) continue;
			nextHashes.set(name, hash);
			panelsOfNext.set(name, panel!);
		}
		const changes = diffStates(current, next);
		current = next;
		if (changes.length > 0) {
			recent.push(...changes);
			while (recent.length > 20) recent.shift();
		}
		// Each page is diffed against what it was itself sent: a page that connects mid-flight gets its own baseline,
		// and a panel that changed while it was connecting is still sent to it.
		for (const sub of [...subscribers.values()]) {
			const panels: Record<string, PanelResult<unknown>> = {};
			let summary: PanelResult<unknown> | undefined;
			let changed = 0;
			for (const [name, hash] of nextHashes) {
				const before = sub.hashes.get(name);
				sub.hashes.set(name, hash);
				if (before === hash) continue;
				changed += 1;
				const panel = panelsOfNext.get(name)!;
				if (name === "summary") summary = panel;
				else panels[name] = panel;
			}
			if (changed === 0 && changes.length === 0) continue;
			write(sub, "panels", {
				generatedAt: next.generatedAt,
				startedAt: next.startedAt,
				...(summary !== undefined ? { summary } : {}),
				panels,
				changes,
			});
		}
	};

	const firstFrame = async (sub: Subscriber): Promise<void> => {
		let state: CommandCenterState;
		try {
			state = await options.state();
		} catch {
			write(sub, "ping", { at: now().toISOString() });
			return;
		}
		if (!current) current = state;
		const openedAt = now().getTime();
		// The state frame was the read the files clock would otherwise repeat at once: its first poll is 10 s away.
		lastFilePollAt = openedAt;
		for (const name of ALL_PANELS) {
			const hash = hashOf(panelOf(state, name));
			if (hash !== undefined) sub.hashes.set(name, hash);
			// The state frame was this panel's read, whether the state held it or not: no floor fires on the
			// first tick after a page connects.
			if (!lastRead.has(name)) lastRead.set(name, openedAt);
		}
		write(sub, "state", state);
	};

	const hub: LiveHub = {
		open: (res, shape) => {
			res.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
				"x-accel-buffering": "no",
				connection: "keep-alive",
			});
			// The browser's own reconnect delay (D30): it reconnects through the listener's checks again.
			res.write("retry: 5000\n\n");
			const sub: Subscriber = { id: nextId++, res, shape, openedAt: now().getTime(), lastFrameAt: now().getTime(), hashes: new Map() };
			while (subscribers.size >= MAX_SUBSCRIBERS) {
				const oldest = subscribers.values().next().value as Subscriber;
				detach(oldest);
				oldest.res.destroy();
			}
			subscribers.set(sub.id, sub);
			res.on("close", () => detach(sub));
			ensureClocks();
			void firstFrame(sub);
		},
		tick: async () => {
			if (subscribers.size === 0) return;
			const nowMs = now().getTime();
			for (const sub of [...subscribers.values()]) {
				if (nowMs - sub.openedAt >= STREAM_LIFETIME_MS) {
					detach(sub);
					if (!sub.res.writableEnded) sub.res.end();
					continue;
				}
				if (nowMs - sub.lastFrameAt >= PING_MS) write(sub, "ping", { at: new Date(nowMs).toISOString() });
			}
			if (subscribers.size === 0) return;
			if (mode === "files") {
				// Files mode: the subscription returned nothing, so every panel is read again on this clock.
				if (nowMs - lastFilePollAt < FILE_MODE_POLL_MS) return;
				lastFilePollAt = nowMs;
				pending.clear();
				for (const name of ALL_PANELS) pending.add(name);
				composeAt = nowMs;
			}
			composing ??= composeDue().finally(() => {
				composing = undefined;
			});
			await composing;
		},
		recentChanges: () => [...recent],
		subscriberCount: () => subscribers.size,
		close: () => {
			if (timer !== undefined) clearInterval(timer);
			timer = undefined;
			unsubscribe?.();
			unsubscribe = undefined;
			mode = "unknown";
			for (const sub of [...subscribers.values()]) {
				detach(sub);
				if (!sub.res.writableEnded) sub.res.end();
			}
		},
	};
	return hub;
}

/**
 * The hub's ledger subscription (D30): document wakes for the compare-and-set stores and the ask append,
 * and the event kinds. Absent on the files backend, where the hub's own 10 s clock is the freshness.
 */
export function ledgerWakeSource(stateDir: string, onWake: (wake: LiveWake) => void): (() => void) | undefined {
	if (readBackend(stateDir) !== "ledger") return undefined;
	const client = createClient(ownerLedgerSocket(stateDir), { timeoutMs: 2000 });
	const off = client.subscribe(
		{ types: [...EVENT_KINDS], docs: ["muster.cas", "muster.ask"] },
		(event) => {
			const type = String((event as { type?: unknown }).type ?? "");
			// The client reports a dropped and restored connection as this type (ledger/client.ts:193), and a
			// restart of musterd may have happened while the hub was away: every panel is stale, not just the board.
			onWake(type === "RECONNECT" ? { kind: "reconnect" } : { kind: "event", type });
		},
		(doc) => onWake({ kind: "doc", docKind: doc.kind, key: doc.key }),
	);
	return () => {
		off();
		client.close();
	};
}
