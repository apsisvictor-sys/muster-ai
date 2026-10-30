/**
 * The dispatcher, A1 (out-loop spec Revision 3 §5, §9 and §10 row OL2; VR24-220, VR24-229).
 *
 * One job: take the next dispatchable work item and start one lane for it, with no orchestrator session turn.
 * It is a pass, not a service — `runTick` calls `dispatchPass` once per tick, globally, outside any
 * programme's pass, so a paused or rotating programme cannot keep a free slot idle.
 *
 * What it decides, and where each answer comes from:
 *   - which items may launch: the work-item registry (`work-items.ts`) is the queue — no private table. An
 *     item is dispatchable when its state is `ready`, it names a brief file that exists and passes
 *     `scripts/brief-check.sh`, it owns at least one path, and it states its project, kind, class and
 *     harness (the record's own validation already refuses anything else);
 *   - what stops a launch: an overlap with the owned paths of an item that is already launched, a live lane
 *     record that names the same item, no free slot (`routing.slots`, VR24-208), the kill file
 *     (`programmeKillFileActive`), the gate's pause flag or its memory answer (`scripts/heavy-gate.sh`), and
 *     the dispatch mode (`state/routing/dispatch-mode`, §9);
 *   - what starts the lane: the worktree step at a verified base, then `scripts/pi-lane-launch.sh` — one
 *     launch effect (§11 rule 2), through the port. The launcher is the one `lane-launch` gate call, so its
 *     60 s spacing (VR24-210) is never restated here and its refusal is "retry later", not a fault;
 *   - what the item records: `launch-uncertain` while a launch is in flight, then `launched:<lane>`. A crash
 *     leaves `launch-uncertain`, which is resolved from the lane record's `item` field, never by relaunching
 *     blind;
 *   - what shadow does: it decides and writes the line it would have acted on, next to the orchestrator's own
 *     launches, and changes nothing — no launch, no item write, no mark, no ask.
 *
 * The rest of this file is the Concord roster's own helpers (`structuredLines`, the next-best-step list):
 * they answer "what does this task record say" for the frontier wake and the lifecycle, and they are not part
 * of the queue.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { REVIEW_FAMILIES, reviewFamilyProblem, workItemStateDetail, type ReviewIdentity, type WorkItemRecord } from "./work-items.ts";

// ─── The switch and its marks ────────────────────────────────────────────────

/** `off` is the rollback, `shadow` decides and logs, `on` launches (§9, §11 rule 1). */
export type DispatchMode = "off" | "shadow" | "on";
export const DISPATCH_MODES: readonly DispatchMode[] = ["off", "shadow", "on"];

/** The launcher's own gate refusal (`heavy-gate.sh`'s refuse exit): the machine is not ready, retry later. */
export const GATED_EXIT = 75;
/** `VR24-220`: after this long gated, the item is a question for the operator, once. */
export const GATED_ASK_AFTER_MS = 30 * 60_000;
/** The three choices an ask carries, in the question's own words (§11 rule 3, `VR24-220`). */
export const GATED_ASK_CHOICES = "wait, stop the window, smaller job";

/** When this item first went gated: the 30-minute clock. */
export function gatedSinceKey(code: string): string {
	return `dispatch:gated-since:${code}`;
}

/** That this item's gating episode has already been asked about: one ask, never a stream. */
export function gatedAskedKey(code: string): string {
	return `dispatch:asked:${code}`;
}

/** The item's current gated reason, so a re-check that finds the same reason writes no line (§11 rule 3). */
export function gatedReasonKey(code: string): string {
	return `dispatch:gated:${code}`;
}

// ─── What the pass reads and does ────────────────────────────────────────────

/** The item fields the dispatcher decides on: the §7a record, read and never written here. */
export type DispatchItem = Pick<
	WorkItemRecord,
	"code" | "heading" | "goal" | "project" | "kind" | "class" | "harness" | "brief" | "ownedPaths" | "dependencies" | "attempt" | "state"
> & {
	/** R2's review identity, absent on a record written before R2 and until a family is chosen. */
	review?: ReviewIdentity;
};

/** One lane record that is still live: the same item served twice is a double launch. */
export type LiveLane = { lane: string; item?: string; phase: string };

/** What one launch needs, in the launcher's own terms. Nothing here decides the model: the router picks. */
export type LaunchRequest = {
	/** The work item's code: the idempotence key's first half and the lane id's stem (§11 rule 2). */
	code: string;
	/** `ol2b-a1`: the item's code and its attempt, lowercased because a lane id is lowercase (`binding.ts`). */
	lane: string;
	attempt: number;
	briefPath: string;
	/** What the lane delivers, in plain words: the item's heading, checked by `validateLaneTitle` at the launch. */
	title: string;
	/** The goal code the item names, when it names one; else the launch says `--no-goal`. */
	goal?: string;
	/** The repository the worktree is created from: the brief's `Cut from:` names it. */
	repo: string;
	/** The base the worktree starts from, as the brief's `Cut from:` names it; the port verifies it to a full SHA. */
	base: string;
	/** Where this attempt's isolated worktree goes. */
	laneRoot: string;
	/** The branch the worktree is created on. */
	branch: string;
	/** The harness the lane runs on: the item's own field. */
	harness: string;
};

/** What the gate said, in its own words, plus the two facts it read off the machine. */
export type GateReading = {
	admitted: boolean;
	/** The gate's refusal reason verbatim; empty when it admitted. */
	reason: string;
	/** The job size the gate used, in MiB, when its own record named one. */
	jobSizeMiB?: number;
	/** MemAvailable as the gate read it, in MiB. */
	availableMiB?: number;
	/** The active dev-server scopes the gate named, when it named any. */
	devServerWindow?: string;
	/** `paused by <who>`, when the pause flag is what refused. */
	pausedBy?: string;
};

/** One launch's answer: whether anything started, and why not when nothing did. */
export type LaunchOutcome = { launched: boolean; error?: string; exitCode?: number };

/** Everything the pass reads or does, supplied by the tick script: the machine stays there. */
export type DispatchPort = {
	now(): number;
	/** Every work item the store holds, and the records it could not read. */
	items(): { items: readonly DispatchItem[]; skipped: readonly { id: string; error: string }[] };
	/** `state/routing/dispatch-mode`: off is the rollback, shadow logs and launches nothing. */
	mode(): DispatchMode;
	/** The lane records that are still live: a launch in flight is never launched again. */
	liveLanes(): readonly LiveLane[];
	/** The Muster state directory the lane worktrees live under: the port's own home, read once. */
	stateDir(): string;
	/** Free worker slots now: the pool's own cap minus the lanes that hold one. Never negative. */
	freeSlots(): number;
	/** The kill file's own answer: a non-empty reason when the programme's stop lever is on. */
	killed(): string | undefined;
	/** The gate's non-recording view: would it admit a lane launch now, and why not. */
	gate(): Promise<GateReading>;
	/** One brief read with `scripts/brief-check.sh`'s verdict: one read, one verdict. */
	brief(path: string): { ok: boolean; reason?: string; text?: string };
	/** The one launch effect: the worktree at a verified base, then `scripts/pi-lane-launch.sh`. */
	launch(request: LaunchRequest): Promise<LaunchOutcome>;
	/** Move one item to a state, recording the dispatcher as the writer. */
	setState(code: string, state: string): { ok: boolean; reason?: string };
	/** The tick's own mark store: the gating clock, the reason and the one-ask mark. */
	mark: { get(key: string): string | undefined; set(key: string, value: string): void };
	/** One shadow line: what this pass would have launched. Written only when the mode is shadow. */
	shadow(line: Record<string, unknown>): void;
	/** One line into the orchestrator event file. */
	event(line: string): void;
	/** One question for the operator, through `asks.ts`. */
	ask(input: { code: string; question: string }): { ok: boolean; reason?: string };
};

/** What one pass concluded, in the tick's action vocabulary. */
export type DispatchOutcome = {
	action: "dispatched" | "dispatch-waiting" | "dispatch-held" | "dispatch-blocked";
	detail: string;
};

// ─── The queue: work items, one reader ───────────────────────────────────────

/** One item that may launch now, with the facts its brief supplied. */
export type ReadyItem = {
	item: DispatchItem;
	briefPath: string;
	/** The base and the repository the brief's `Cut from:` line names. */
	base: string;
	repo: string;
};

export type HeldItem = { code: string; why: string };

export type DispatchQueue = { ready: ReadyItem[]; held: HeldItem[] };

/**
 * Why a review item may not be launched (R2): the record's own rule, read here so an item whose identity is
 * absent or wrong is held rather than launched on a family that does not differ from the author's and the
 * parent's. `undefined` is dispatchable.
 */
export function reviewFamilyHeld(item: DispatchItem): string | undefined {
	if (item.kind !== "review") return undefined;
	const problem = reviewFamilyProblem({ kind: item.kind, review: item.review });
	if (problem !== undefined) return problem;
	if (item.review?.reviewer === undefined) {
		return `its review identity is not on the item the dispatcher reads, so no reviewer family can be checked against the author's and the parent's; a review launches only with one that differs from both (${REVIEW_FAMILIES.join(", ")})`;
	}
	return undefined;
}

/** The only state an item launches from: `ready` is its owner's word that the item may go. */
const DISPATCHABLE_STATE = "ready";

/** True for a state that says a lane holds this item (its work is in flight). */
function isLaunched(state: string): boolean {
	return state.startsWith("launched:");
}

function normalizePath(file: string): string {
	const trimmed = file.trim().replace(/^\.\//, "").replace(/\/+$/, "");
	return trimmed === "." ? "" : trimmed;
}

/** Two owned paths conflict when one is a prefix of the other, compared as directory paths. */
export function pathsOverlap(left: string, right: string): boolean {
	const a = normalizePath(left);
	const b = normalizePath(right);
	if (a === "" || b === "") return false;
	if (a === b) return true;
	return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** The item already holding one of these paths, if any: the reason a second lane is not launched yet. */
export function heldByLaunchedItem(
	item: DispatchItem,
	items: readonly DispatchItem[],
): { code: string; path: string; held: string } | undefined {
	for (const other of items) {
		if (other.code === item.code || !isLaunched(other.state)) continue;
		for (const held of other.ownedPaths) {
			for (const owned of item.ownedPaths) {
				if (pathsOverlap(owned, held)) return { code: other.code, path: owned, held };
			}
		}
	}
	return undefined;
}

/**
 * The dependencies a dispatchable item declares that are not met: an entry naming another work item must
 * find that item `done`. An entry that names no item is a condition (a gate, a window, a ruling) that the
 * registry cannot judge, so the dispatcher does not pretend to; A2 owns it and `ready` is its word.
 */
export function unmetDependencies(item: DispatchItem, items: readonly DispatchItem[]): string[] {
	const byCode = new Map(items.map((entry) => [entry.code, entry] as const));
	return item.dependencies
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "" && byCode.has(entry))
		.filter((entry) => byCode.get(entry)!.state !== "done");
}

/**
 * The ready queue, in a stable order (item code), with everything else held and the reason it is held.
 * `brief` is the port's one read: a brief that is missing, fails `brief-check.sh`, or names no base or
 * repository is not launchable, and saying so is the whole point of holding the item.
 */
export function readyItems(input: {
	items: readonly DispatchItem[];
	liveLanes: readonly LiveLane[];
	brief: (absolutePath: string) => { ok: boolean; reason?: string; text?: string };
}): DispatchQueue {
	const ready: ReadyItem[] = [];
	const held: HeldItem[] = [];
	const liveItems = new Set(input.liveLanes.flatMap((lane) => (lane.item === undefined ? [] : [lane.item])));
	for (const item of [...input.items].sort((left, right) => left.code.localeCompare(right.code))) {
		if (item.state !== DISPATCHABLE_STATE) continue;
		if (liveItems.has(item.code)) {
			held.push({ code: item.code, why: "a live lane record already names this item, so nothing is launched twice" });
			continue;
		}
		const unmet = unmetDependencies(item, input.items);
		if (unmet.length > 0) {
			held.push({ code: item.code, why: `waiting for ${unmet.join(", ")}` });
			continue;
		}
		if (item.brief.trim() === "") {
			held.push({ code: item.code, why: "no brief file named (its brief field is empty)" });
			continue;
		}
		if (item.ownedPaths.length === 0) {
			held.push({ code: item.code, why: "it owns no paths, so a lane's scope and a claim conflict cannot be checked" });
			continue;
		}
		if (item.project.trim() === "" || item.kind.trim() === "" || item.class.trim() === "" || item.harness.trim() === "") {
			held.push({ code: item.code, why: "its project, kind, class or harness is not stated, so no lane can be picked" });
			continue;
		}
		const reviewHeld = reviewFamilyHeld(item);
		if (reviewHeld !== undefined) {
			held.push({ code: item.code, why: reviewHeld });
			continue;
		}
		const conflict = heldByLaunchedItem(item, input.items);
		if (conflict !== undefined) {
			held.push({ code: item.code, why: `${conflict.path} is held by ${conflict.code} (${conflict.held})` });
			continue;
		}
		const read = input.brief(item.brief);
		if (!read.ok) {
			held.push({ code: item.code, why: read.reason ?? `the brief ${item.brief} is not readable` });
			continue;
		}
		const text = read.text ?? "";
		const base = baseFromBrief(text);
		if (base === undefined) {
			held.push({ code: item.code, why: "its brief names no base commit in its Cut from line, so no verified worktree can be made" });
			continue;
		}
		const repo = repoFromBrief(text);
		if (repo === undefined) {
			held.push({ code: item.code, why: "its brief names no repository in its Cut from line, so its worktree has no source" });
			continue;
		}
		ready.push({ item, briefPath: item.brief, base, repo });
	}
	return { ready, held };
}

// ─── The lane, in the launcher's own terms ───────────────────────────────────

/**
 * The lane id for one attempt of an item: the item's code and its attempt (`OL2B` attempt 1 → `ol2b-a1`).
 * Lowercase because a lane id is `[a-z][a-z0-9_-]{0,31}` (`binding.ts`), and the attempt comes from the
 * item's own field so a retry cannot silently reuse or fork a lane (§11 rule 2).
 */
export function laneForItem(code: string, attempt: number): string {
	const stem = code.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "item";
	return `${stem}-a${Math.max(1, Math.trunc(attempt))}`;
}

/** Where one attempt's worktree lives: one directory per lane, which is one per item and attempt. */
export function laneRootFor(stateDir: string, lane: string): string {
	return join(stateDir, "lanes", lane);
}

/** The branch a lane's worktree is created on. */
export function laneBranchFor(lane: string): string {
	return `lane/${lane}`;
}

/** What the lane delivers, in plain words: the item's heading, one line, bounded (`validateLaneTitle`'s input). */
export function titleForItem(item: DispatchItem): string {
	const text = item.heading.trim() !== "" ? item.heading : `${item.code} ${item.goal}`.trim();
	return oneLine(text.replace(/\s+/g, " "), 80);
}

/**
 * The goal code the item names, when it names exactly one bare code (`out-loop`, `OL2`). A goal cell that
 * spells a sentence names no code the goal registry can hold, so the launch says `--no-goal`.
 */
export function goalForItem(item: DispatchItem): string | undefined {
	const cell = item.goal.trim();
	if (!/^[A-Za-z][A-Za-z0-9-]{1,15}$/.test(cell)) return undefined;
	return cell;
}

/**
 * The base a brief names in its `Cut from:` line, exactly as written: a hex token of seven or more
 * characters. The port resolves it to a full commit and refuses one that is not a commit, so an abbreviated
 * SHA in a hand-written brief still names a verified base, and a brief that names no base is never launched.
 */
export function baseFromBrief(text: string): string | undefined {
	const cut = /^[ \t>*_#-]*Cut from[*_]*:(.*)$/im.exec(text);
	const source = cut?.[1] ?? text;
	return /\b([0-9a-f]{7,64})\b/i.exec(source)?.[1];
}

/**
 * The repository a brief's `Cut from:` line names: a `repo <path>` token, or the parenthesised path that
 * follows the base (`Pi main at 81efad51 (~/.pi/agent)`). The brief is the only truthful source for where a
 * lane's worktree comes from, because a hand-written brief states it and the item does not.
 */
export function repoFromBrief(text: string): string | undefined {
	const cut = /^[ \t>*_#-]*Cut from[*_]*:(.*)$/im.exec(text);
	const source = cut?.[1] ?? text;
	const named = /\brepo[:\s]+([~\/][^\s,;)]*)/i.exec(source)?.[1] ?? /\(([~\/][^\s,;)]*)\)/.exec(source)?.[1];
	if (named === undefined) return undefined;
	const trimmed = named.replace(/[.,;:]+$/, "");
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
	return trimmed.startsWith("/") ? trimmed : undefined;
}

// ─── The gate's words, in the item's own line ────────────────────────────────

/** The scope holding the machine, in one phrase: the gate's reason, made into a name a reader can scan. */
export function holdScope(gate: GateReading): string {
	if (gate.pausedBy !== undefined && gate.pausedBy !== "") return gate.pausedBy;
	if (gate.devServerWindow !== undefined && gate.devServerWindow !== "") return gate.devServerWindow;
	const reason = gate.reason.trim();
	if (/^another lane launch passed the gate/i.test(reason)) return "launch spacing";
	if (/^memory pressure avg10/i.test(reason)) return "memory pressure";
	if (/^pi\.slice holds/i.test(reason)) return "pi.slice";
	if (/^only \d+ MiB of memory is available/i.test(reason)) return "low memory";
	if (/^paused by /i.test(reason)) return reason.replace(/ at .*$/, "");
	return reason === "" ? "the gate" : reason;
}

/**
 * The item's waiting line, in the machine's own words: `waiting: needs N MiB, M free, held by <scope>`. The
 * numbers are the gate's own (its refusal names the job size it used, its status names MemAvailable), never a
 * table kept here.
 */
export function composeGatedLine(gate: GateReading): string {
	const size = gate.jobSizeMiB ?? /for the (\d+) MiB job/i.exec(gate.reason)?.[1];
	const free = gate.availableMiB ?? /only (\d+) MiB of memory is available/i.exec(gate.reason)?.[1];
	const parts: string[] = [];
	if (size !== undefined) parts.push(`needs ${size} MiB`);
	if (free !== undefined) parts.push(`${free} free`);
	// A refusal with no numbers to quote (the launcher's own answer, §12 F2) carries the gate's words instead:
	// the item says what actually happened, not only which scope did it.
	parts.push(size === undefined && free === undefined ? `held by ${holdScope(gate)}: ${oneLine(gate.reason, 120)}` : `held by ${holdScope(gate)}`);
	return `waiting: ${parts.join(", ")}`;
}

/** One line of text from whatever a launcher or a reader said: the first line, trimmed, bounded. */
function oneLine(text: string, chars = 160): string {
	const line = text.split(/\r?\n/).map((part) => part.trim()).find((part) => part !== "") ?? "no reason was given";
	return line.length > chars ? `${line.slice(0, chars - 1)}…` : line;
}

/** A mark's value, with the store's own "empty means absent" spelling. */
function markOf(port: DispatchPort, key: string): string | undefined {
	const value = port.mark.get(key);
	return value === undefined || value === "" ? undefined : value;
}

/** The question one gated item raises, once: what the gate says, and the operator's three choices. */
export function gatedAskText(item: DispatchItem, line: string): string {
	return [
		`Work item ${item.code} has been held by the resource gate for 30 minutes: ${line}.`,
		`The item is: ${oneLine(item.heading, 140)}.`,
		`Choices: ${GATED_ASK_CHOICES}. The dispatcher keeps retrying at every tick until you answer.`,
	].join(" ");
}

/**
 * The class a refusal belongs to, in the spec's own list (§9): what the refusal was about, so the item's
 * `gated:<class>` says whether the item or the item's lane is what needs an owner.
 */
export function refusalClass(outcome: LaunchOutcome): "gate" | "title" | "goal" | "live-record" | "model-wait" | "launch" {
	const text = (outcome.error ?? "").toLowerCase();
	if (outcome.exitCode === GATED_EXIT) return "gate";
	if (/needs --title|title is refused|--title/.test(text)) return "title";
	if (/--goal|no goal |goal is refused/.test(text)) return "goal";
	if (/live record|already has a live|refusing to overwrite/.test(text)) return "live-record";
	if (/model|wall|quota/.test(text)) return "model-wait";
	return "launch";
}

// ─── The pass ────────────────────────────────────────────────────────────────

/**
 * One pass: start at most one lane, or report what holds the queue. Never throws: every read that fails
 * becomes the pass's own words, because a dispatcher that crashed on one bad record would stop launching
 * every other item.
 */
export async function dispatchPass(port: DispatchPort): Promise<DispatchOutcome | undefined> {
	const mode = port.mode();
	// §11 rule 1: off is the rollback — no read, no line, no launch.
	if (mode === "off") return undefined;
	const now = port.now();
	let items: readonly DispatchItem[];
	let skipped: readonly { id: string; error: string }[];
	try {
		const read = port.items();
		items = read.items;
		skipped = read.skipped;
	} catch (error) {
		return { action: "dispatch-held", detail: `no pass: the work items could not be read (${errorMessage(error)})` };
	}
	if (skipped.length > 0) {
		// A record that fails to validate is never reset and never guessed at; the pass names it and carries on.
		port.event(`${new Date(now).toISOString()} DISPATCH HELD: ${skipped.map((row) => `${row.id} (${row.error})`).join("; ")}`);
	}
	let liveLanes: readonly LiveLane[];
	try {
		liveLanes = port.liveLanes();
	} catch (error) {
		return { action: "dispatch-held", detail: `no pass: the lane records could not be read (${errorMessage(error)})` };
	}
	// §11 rule 2: a crash leaves `launch-uncertain`, and the lane record's `item` field resolves it. Shadow
	// changes nothing, so it resolves nothing either.
	if (mode === "on") resolveUncertain(port, items, liveLanes, now);
	const queue = readyItems({ items, liveLanes, brief: (path) => port.brief(path) });
	if (queue.ready.length === 0) {
		if (queue.held.length === 0) return undefined;
		return { action: "dispatch-held", detail: `nothing launchable: ${queue.held.map((row) => `${row.code}: ${row.why}`).join("; ")}` };
	}
	const free = Math.max(0, Math.trunc(port.freeSlots()));
	if (free === 0) {
		return { action: "dispatch-held", detail: `waiting: no free lane slot (${queue.ready.length} item(s) ready)` };
	}
	const next = queue.ready[0]!;
	const lane = laneForItem(next.item.code, next.item.attempt);
	const request: LaunchRequest = {
		code: next.item.code,
		lane,
		attempt: next.item.attempt,
		briefPath: next.briefPath,
		title: titleForItem(next.item),
		...(goalForItem(next.item) === undefined ? {} : { goal: goalForItem(next.item)! }),
		repo: next.repo,
		base: next.base,
		laneRoot: laneRootFor(port.stateDir(), lane),
		branch: laneBranchFor(lane),
		harness: next.item.harness,
	};
	if (mode === "shadow") {
		// §11 rule 1 and §9: the decision is written down beside the orchestrator's own launches, and nothing is
		// started, no mark is set, no item moves and no ask is raised.
		port.shadow({
			at: new Date(now).toISOString(),
			by: "dispatcher",
			item: next.item.code,
			lane,
			attempt: next.item.attempt,
			title: request.title,
			goal: request.goal ?? null,
			project: next.item.project,
			harness: request.harness,
			brief: next.briefPath,
			repo: next.repo,
			base: next.base,
			laneRoot: request.laneRoot,
		});
		return { action: "dispatch-held", detail: `shadow: would launch ${next.item.code} as ${lane} from ${next.repo}@${next.base}; nothing was started` };
	}
	// §11 rule 2: a lane id that already has a live record is never started again — that would replace the
	// session holding it. The item waits with the class §9 names, and an owner decides (review F4).
	if (liveLanes.some((entry) => entry.lane === lane)) {
		const held = `gated:live-record`;
		port.setState(next.item.code, held);
		port.event(`${new Date(now).toISOString()} DISPATCH REFUSED: ${next.item.code} as ${lane} | live-record | its lane id already has a live record`);
		return { action: "dispatch-blocked", detail: `${next.item.code}: lane ${lane} already has a live record, so nothing was started` };
	}
	// The machine's own stop levers, before anything is created. The gate read is the non-recording status
	// view, so the launcher's own `lane-launch` call stays the one admission that counts (VR24-210).
	const killed = port.killed();
	if (killed !== undefined) {
		const line = `waiting: held by the kill file (${killed})`;
		return gatedItem(port, next.item, line, now);
	}
	let gate: GateReading;
	try {
		gate = await port.gate();
	} catch (error) {
		return { action: "dispatch-held", detail: `no pass: the gate could not be asked (${errorMessage(error)})` };
	}
	if (!gate.admitted) return gatedItem(port, next.item, composeGatedLine(gate), now);
	// §11 rule 2: the attempt is marked in flight before the effect runs, so a crash here is resolvable and never
	// a blind relaunch.
	const uncertain = port.setState(next.item.code, "launch-uncertain");
	if (!uncertain.ok) {
		return { action: "dispatch-blocked", detail: `${next.item.code}: its launch could not be marked in flight (${uncertain.reason ?? "unknown"}), so nothing was started` };
	}
	let outcome: LaunchOutcome;
	try {
		outcome = await port.launch(request);
	} catch (error) {
		outcome = { launched: false, error: errorMessage(error) };
	}
	if (outcome.launched) {
		const wrote = port.setState(next.item.code, `launched:${lane}`);
		clearGating(port, next.item.code);
		port.event(`${new Date(now).toISOString()} DISPATCH LAUNCHED: ${next.item.code} as ${lane} from ${next.repo}@${next.base}`);
		const detail = `launched ${next.item.code} as ${lane} (attempt ${next.item.attempt}) in ${request.laneRoot}`;
		return { action: "dispatched", detail: wrote.ok ? detail : `${detail} (but its state could not be written: ${wrote.reason ?? "unknown"})` };
	}
	// The launcher's gate refusal is the machine's answer, not a fault of the item: it waits, keeps `ready`, and
	// the next tick tries again (VR24-210's spacing is never raced by a state change).
	if (outcome.exitCode === GATED_EXIT) {
		port.setState(next.item.code, "ready");
		return gatedItem(port, next.item, composeGatedLine({ admitted: false, reason: outcome.error ?? "the gate refused the launch" }), now);
	}
	const reason = oneLine(outcome.error ?? "the launcher failed");
	// A launch that failed after the lane started is not undone and not reported as nothing: the lane record is
	// the owner of "did anything start", so it decides whether the item is launched or refused (F4).
	let started: readonly LiveLane[] = [];
	try {
		started = port.liveLanes().filter((entry) => entry.lane === lane);
	} catch {
		/* an unreadable lane store leaves the item refused below, which is the safe reading */
	}
	if (started.length > 0) {
		port.setState(next.item.code, `launched:${lane}`);
		port.event(`${new Date(now).toISOString()} DISPATCH FAULT: ${next.item.code} as ${lane} started but its launch reported: ${reason}`);
		return { action: "dispatch-blocked", detail: `${next.item.code}: its lane ${lane} started, but the launch reported: ${reason}` };
	}
	// Anything else is about the item or about starting it: `gated:<class>` says which, once (§9), and one
	// event line records the launcher's own words. The attempt is not retried on its own.
	const cls = refusalClass(outcome);
	port.setState(next.item.code, `gated:${cls}`);
	port.event(`${new Date(now).toISOString()} DISPATCH REFUSED: ${next.item.code} as ${lane} | ${cls} | ${reason}`);
	return { action: "dispatch-blocked", detail: `${next.item.code}: ${reason}` };
}

/** A pass that waits: the reason is recorded once per change (§11 rule 3), with the one ask a long wait earns. */
function gatedItem(port: DispatchPort, item: DispatchItem, line: string, now: number): DispatchOutcome {
	if (markOf(port, gatedReasonKey(item.code)) !== line) {
		port.mark.set(gatedReasonKey(item.code), line);
		port.event(`${new Date(now).toISOString()} DISPATCH WAITING: ${item.code} ${line}`);
	}
	const since = Number(markOf(port, gatedSinceKey(item.code)) ?? Number.NaN);
	if (!Number.isFinite(since)) {
		port.mark.set(gatedSinceKey(item.code), String(now));
	} else if (now - since >= GATED_ASK_AFTER_MS && markOf(port, gatedAskedKey(item.code)) === undefined) {
		if (port.ask({ code: item.code, question: gatedAskText(item, line) }).ok) port.mark.set(gatedAskedKey(item.code), String(now));
	}
	const waited = Number.isFinite(since) ? ` for ${Math.round((now - since) / 60_000)} min` : "";
	const asked = markOf(port, gatedAskedKey(item.code)) === undefined ? "" : ` (one ask raised: ${GATED_ASK_CHOICES})`;
	return { action: "dispatch-waiting", detail: `${item.code} ${line}${waited}${asked}` };
}

/** An item that leaves the gate behind carries no gating clock, no ask mark and no stale reason. */
function clearGating(port: DispatchPort, code: string): void {
	port.mark.set(gatedSinceKey(code), "");
	port.mark.set(gatedAskedKey(code), "");
	port.mark.set(gatedReasonKey(code), "");
}

/**
 * Resolve every item a crash left `launch-uncertain`: the lane record's own `item` field says whether a lane
 * started for it. A live record means the launch happened (`launched:<lane>`); no live record means nothing
 * started, so the item is `ready` again and the next pass may try. Nothing is ever relaunched blind (§11 rule 2).
 */
function resolveUncertain(port: DispatchPort, items: readonly DispatchItem[], liveLanes: readonly LiveLane[], now: number): void {
	for (const item of items) {
		if (item.state !== "launch-uncertain") continue;
		const lane = liveLanes.find((entry) => entry.item === item.code);
		if (lane !== undefined) {
			port.setState(item.code, `launched:${lane.lane}`);
			port.event(`${new Date(now).toISOString()} DISPATCH RESOLVED: ${item.code} was launched as ${lane.lane} (its lane record says so)`);
		} else {
			port.setState(item.code, "ready");
			port.event(`${new Date(now).toISOString()} DISPATCH RESOLVED: ${item.code} has no lane record, so nothing started and it is ready again`);
		}
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A plain-words line naming what the queue holds, for the tick's action detail. */
export function readyQueueReason(queue: DispatchQueue, launched: number, freeLanes: number): string {
	const parts: string[] = [];
	if (launched > 0) parts.push(`launched ${launched} lane${launched === 1 ? "" : "s"}: ${queue.ready.slice(0, launched).map((row) => row.item.code).join(", ")}`);
	if (queue.held.length > 0) parts.push(`held ${queue.held.map((row) => `${row.code}: ${row.why}`).join("; ")}`);
	if (launched === 0 && queue.held.length === 0 && freeLanes > 0) parts.push(`${freeLanes} free lane${freeLanes === 1 ? "" : "s"}, nothing ready`);
	return parts.join("; ");
}

/** The state detail of an item, for a caller that renders `launched:<lane>`: one reader, one meaning. */
export function launchedLane(item: DispatchItem): string | undefined {
	return isLaunched(item.state) ? workItemStateDetail(item.state) : undefined;
}

// ─── The Concord roster's own helpers (frontier wake, lifecycle) ─────────────

/** One Concord task row, as far as the roster helpers read it. */
export type DispatchTask = {
	taskId: string;
	status: string;
	ownerAgentId?: string;
	assignedAgentId?: string;
	expectedFiles?: string[];
	/** Structured lines (`dep:`, `brief:`, `next:`, `risk:`, `finding:`) from notes or risk tags. */
	notes?: string;
	riskTags?: string[];
};

/** Structured `key: value` lines from a task's notes and risk tags. */
export function structuredLines(task: DispatchTask): Map<string, string[]> {
	const out = new Map<string, string[]>();
	const source = [task.notes ?? "", ...(task.riskTags ?? [])].join("\n");
	for (const raw of source.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		const match = /^([a-z_]+):\s*(.+)$/.exec(line);
		if (match === null) continue;
		const key = match[1]!;
		const value = match[2]!.trim();
		if (value === "") continue;
		const existing = out.get(key);
		if (existing === undefined) out.set(key, [value]);
		else existing.push(value);
	}
	return out;
}

export type NextStepSource = "next" | "risk" | "finding" | "blocked" | "check";

export type NextStepCandidate = { source: NextStepSource; taskId?: string; text: string };

/**
 * The candidate list the frontier wake hands the parent when the ready queue is
 * empty and lanes are free: the next steps and known risks it recorded on
 * accepted work, failing checks and open findings carried on tasks. It ranks
 * nothing — that is the parent's judgment, made with the programme in view. A
 * product-rule question in here becomes a decision card, never a guess.
 */
export function nextBestStepCandidates(input: {
	tasks: readonly DispatchTask[];
	/** Failing checks the metrics/journals already report, as plain lines. */
	failingChecks?: readonly string[];
	/** Acceptance findings still open, as plain lines. */
	openFindings?: readonly string[];
}): NextStepCandidate[] {
	const out: NextStepCandidate[] = [];
	const seen = new Set<string>();
	const push = (candidate: NextStepCandidate): void => {
		const key = `${candidate.source}\u0000${candidate.text}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push(candidate);
	};
	for (const task of input.tasks) {
		const fields = structuredLines(task);
		if (task.status === "blocked") push({ source: "blocked", taskId: task.taskId, text: `${task.taskId} is blocked and needs a decision or a fix` });
		for (const value of fields.get("next") ?? []) push({ source: "next", taskId: task.taskId, text: value });
		for (const value of fields.get("risk") ?? []) push({ source: "risk", taskId: task.taskId, text: value });
		for (const value of fields.get("finding") ?? []) push({ source: "finding", taskId: task.taskId, text: value });
	}
	for (const line of input.failingChecks ?? []) push({ source: "check", text: line });
	for (const line of input.openFindings ?? []) push({ source: "finding", text: line });
	return out;
}

/** The wake text for the parent: what to brief next, or what to choose from. */
export function nextBestStepText(candidates: readonly NextStepCandidate[]): string {
	if (candidates.length === 0) return "No ready task and no candidate next step was recorded. Look at the plan and the accepted handoffs before creating work.";
	const lines = candidates.map((candidate) => `- [${candidate.source}] ${candidate.text}`);
	return ["Nothing is dispatchable and lanes are free. Rank these candidates by how much each unblocks and its user value, then create tasks with briefs; a product-rule question becomes a decision card, never a guess:", ...lines].join("\n");
}
