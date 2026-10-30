/**
 * Henry's mailbox health (VR24-12 C9 and C10): two checks that tell the orchestrator when the wake path to Henry is
 * broken. A failure is one event line through the one event writer (`recordOrchestratorEvent`, the owner behind
 * `muster event`), never a new channel.
 *
 * - `checkMailboxAuth` (C9): the `gh` login that opens the assigned mailbox issues can still read the mailbox repo.
 *   A 401 killed the wakes on 2026-10-22 and 2026-10-24 and nothing said so. The line carries gh's own one-line
 *   error, redacted. No token is read, passed or logged here: `gh` finds its own login.
 * - `checkUnreadForHenry` (C10): any message in Henry's outbox (the ledger's pending messages for the gateway
 *   address, the flag his `outbox_read` clears) older than 30 minutes. The line names counts, senders and short
 *   ids, never a message's text.
 *
 * Each check dedupes its own alerts in `mailbox-health.json` beside the Muster state, so a timer that fires every
 * few minutes raises one line per failure episode (auth: again after `AUTH_REPEAT_MS`; unread: again after
 * `UNREAD_REPEAT_MS` while the same messages stay unread, or at once for a different set).
 */

import { join } from "node:path";
import { redactSensitiveText } from "../core/self-improving-redactor.ts";
import { readJsonSettingsFile, updateJsonSettingsFile } from "../core/atomic-settings.ts";
import { GATEWAY_AGENT_ID } from "./gateway/state.ts";
import { DEFAULT_MAILBOX_REPO, type WakeExec } from "./grokbot-wake.ts";
import { formatEventLine, recordOrchestratorEvent, type EventKind } from "./lane-report.ts";
import { listInboxMessages } from "./lib/agent-inbox.ts";

/** The event line's lane: the mailbox is not a lane, and the name says what the line is about. */
export const MAILBOX_LANE = "henry-mailbox";
/** A failing login raises again this long after the last line. */
export const AUTH_REPEAT_MS = 6 * 60 * 60_000;
/** A message is stale after this long unread (VR24-12 C10). */
export const UNREAD_AFTER_MS = 30 * 60_000;
/** The same stale set raises again this long after the last line. */
export const UNREAD_REPEAT_MS = 20 * 60 * 60_000;
export const AUTH_CHECK_TIMEOUT_MS = 15_000;
const DETAIL_CHARS = 200;
const LISTED_IDS = 5;

type HealthState = { version: 1; auth?: { raisedAt: number }; unread?: { raisedAt: number; ids: string[] } };
const EMPTY_STATE: HealthState = { version: 1 };

export const mailboxHealthFile = (stateDir: string): string => join(stateDir, "mailbox-health.json");
const readState = (stateDir: string): HealthState => readJsonSettingsFile<HealthState>(mailboxHealthFile(stateDir), EMPTY_STATE);
const updateState = (stateDir: string, update: (state: HealthState) => HealthState): void => void updateJsonSettingsFile<HealthState>(mailboxHealthFile(stateDir), EMPTY_STATE, update);

/** One event line through the one writer. True when it is recorded or kept for replay (musterd down). */
function raise(stateDir: string, kind: EventKind, detail: string, now: Date): boolean {
	return recordOrchestratorEvent(stateDir, formatEventLine(kind, MAILBOX_LANE, detail), now) !== false;
}

export type MailboxDeps = { stateDir: string; now?: () => Date };

export type AuthCheck = { ok: true } | { ok: false; detail: string; raised: boolean };

/** gh's own one-line answer, redacted and cut: the only thing of gh's that is ever written down. */
function oneLine(text: string): string {
	const first = text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
	return redactSensitiveText(first, { preservePaths: true, strictAssignments: true }).slice(0, DETAIL_CHARS);
}

/**
 * C9: read the mailbox repo as the login that opens its issues. A clean read clears the failure; a failure raises
 * one BLOCKED line naming gh's error, and again after `AUTH_REPEAT_MS` while it keeps failing.
 */
export async function checkMailboxAuth(deps: MailboxDeps & { exec: WakeExec; repo?: string; gh?: string }): Promise<AuthCheck> {
	const now = deps.now?.() ?? new Date();
	const repo = deps.repo ?? DEFAULT_MAILBOX_REPO;
	let failure: string | undefined;
	try {
		const result = await deps.exec(deps.gh ?? "gh", ["api", `repos/${repo}`, "--jq", ".full_name"], AUTH_CHECK_TIMEOUT_MS);
		if (result.exitCode !== 0) failure = oneLine(result.stderr || result.stdout) || (result.exitCode === null ? "gh did not answer" : `gh exited ${result.exitCode}`);
	} catch (error) {
		failure = oneLine(error instanceof Error ? error.message : String(error)) || "gh could not be started";
	}
	if (failure === undefined) {
		if (readState(deps.stateDir).auth !== undefined) updateState(deps.stateDir, ({ auth: _cleared, ...rest }) => rest);
		return { ok: true };
	}
	const last = readState(deps.stateDir).auth?.raisedAt;
	if (last !== undefined && now.getTime() - last < AUTH_REPEAT_MS) return { ok: false, detail: failure, raised: false };
	const raised = raise(deps.stateDir, "BLOCKED", `the GitHub login that opens ${repo} issues failed, so Henry's wakes are not going out: ${failure} (needs: a working \`gh\` login for the account that owns ${repo})`, now);
	if (raised) updateState(deps.stateDir, (state) => ({ ...state, auth: { raisedAt: now.getTime() } }));
	return { ok: false, detail: failure, raised };
}

export type StaleMessage = { id: string; from: string; ageMs: number };
export type UnreadCheck = { stale: StaleMessage[]; raised: boolean };

function ageText(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

/**
 * C10: the messages in Henry's outbox older than `UNREAD_AFTER_MS`. One STALLED line lists the count, the senders
 * and up to five short ids, oldest first. Nothing is raised when nothing is stale, and a stale set that was already
 * raised stays quiet until `UNREAD_REPEAT_MS` has passed.
 */
export function checkUnreadForHenry(deps: MailboxDeps & { agentId?: string }): UnreadCheck {
	const now = deps.now?.() ?? new Date();
	const stale: StaleMessage[] = listInboxMessages(deps.stateDir, deps.agentId ?? GATEWAY_AGENT_ID)
		.map((message) => ({ id: message.id, from: message.from, ageMs: now.getTime() - Date.parse(message.at) }))
		.filter((message) => Number.isFinite(message.ageMs) && message.ageMs > UNREAD_AFTER_MS)
		.sort((a, b) => b.ageMs - a.ageMs);
	if (stale.length === 0) {
		if (readState(deps.stateDir).unread !== undefined) updateState(deps.stateDir, ({ unread: _cleared, ...rest }) => rest);
		return { stale, raised: false };
	}
	const ids = stale.map((message) => message.id).sort();
	const last = readState(deps.stateDir).unread;
	if (last !== undefined && now.getTime() - last.raisedAt < UNREAD_REPEAT_MS && last.ids.length === ids.length && last.ids.every((id, at) => id === ids[at])) return { stale, raised: false };
	const senders = [...new Set(stale.map((message) => message.from))].sort().join(", ");
	const listed = stale.slice(0, LISTED_IDS).map((message) => message.id.slice(0, 8)).join(", ");
	const more = stale.length > LISTED_IDS ? ` and ${stale.length - LISTED_IDS} more` : "";
	const raised = raise(deps.stateDir, "STALLED", `${stale.length} message(s) to Henry unread for more than ${UNREAD_AFTER_MS / 60_000} min, oldest ${ageText(stale[0]!.ageMs)} (from ${senders}; ids ${listed}${more}); read them with outbox_read`, now);
	if (raised) updateState(deps.stateDir, (state) => ({ ...state, unread: { raisedAt: now.getTime(), ids } }));
	return { stale, raised };
}
