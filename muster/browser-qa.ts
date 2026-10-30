/**
 * Browser QA cleanup (LD11): a lane that drives Claude in Chrome closes the tabs
 * it opened before it ends a turn.
 *
 * One owner of what a Chrome tab tool call means for the lane record, of the words
 * the Stop hook says, and of the rule for when it says them. The ledger itself
 * (`openTabs` on the lane record) is written by `recordTabOpened` and
 * `recordTabClosed` in `lane-lifecycle.ts`. The hook (`cli/claude-hook.ts`) only
 * asks this module and delivers the answer in its own block.
 *
 * Not asked: the orchestrator and the operator's own sessions (the same exemption as the
 * report nudge). The answer is given at every turn end while a tab is open, and
 * Claude Code's `stop_hook_active` rule keeps it to one block per stop.
 */

import { readLaneRecord, recordTabClosed, recordTabOpened, type LaneRecord } from "./lane-lifecycle.ts";
import { reportNudgeExempt } from "./report-nudge.ts";
import type { SeatContext } from "./seats.ts";

/** What a Chrome tab tool result did to the lane's tabs. */
export type TabEvent = { kind: "opened"; tabId: number } | { kind: "closed"; tabId: number };

const TAB_TOOL = /(?:^|__)claude-in-chrome__tabs_(create|close)_mcp$/;
const CREATED = /Created new tab\.\s*Tab ID:\s*(\d+)/;
const CLOSED = /Closed tab (\d+)\b/;

/**
 * The tab event of one `PostToolUse` payload, or undefined when it is another tool or the call
 * did not succeed. The tool's own result text decides: `Created new tab. Tab ID: <id>` and
 * `Closed tab <id>.` A failed close keeps the tab in the ledger, because the tab is still open.
 */
export function tabEventOf(payload: { tool_name?: unknown; tool_response?: unknown }): TabEvent | undefined {
	const tool = typeof payload.tool_name === "string" ? TAB_TOOL.exec(payload.tool_name) : null;
	if (tool === null) return undefined;
	let text: string;
	try {
		text = typeof payload.tool_response === "string" ? payload.tool_response : JSON.stringify(payload.tool_response ?? "");
	} catch {
		return undefined;
	}
	const match = (tool[1] === "create" ? CREATED : CLOSED).exec(text);
	if (match === null) return undefined;
	const tabId = Number(match[1]);
	return Number.isSafeInteger(tabId) ? { kind: tool[1] === "create" ? "opened" : "closed", tabId } : undefined;
}

/** Apply one tab event to the lane's record. False when the lane has no record. */
export function applyTabEvent(stateDir: string, laneId: string, event: TabEvent): boolean {
	return event.kind === "opened" ? recordTabOpened(stateDir, laneId, event.tabId) : recordTabClosed(stateDir, laneId, event.tabId);
}

/** The words the Stop hook delivers. */
export function openTabsNudgeText(tabIds: readonly number[]): string {
	return `Close your tabs before ending the turn: tabs_close_mcp for ${tabIds.join(", ")}.`;
}

/** The nudge for this lane's open tabs, or undefined when there is nothing to close. */
export function openTabsNudge(laneId: string, record: Pick<LaneRecord, "browser" | "openTabs"> | undefined, seats?: SeatContext): string | undefined {
	if (record === undefined || reportNudgeExempt(laneId, seats) || record.browser !== true) return undefined;
	const tabs = record.openTabs ?? [];
	return tabs.length === 0 ? undefined : openTabsNudgeText(tabs);
}

/** Read the lane's record and return its open-tabs nudge. */
export function openTabsNudgeFor(stateDir: string, laneId: string): string | undefined {
	return openTabsNudge(laneId, readLaneRecord(stateDir, laneId), { stateDir });
}
