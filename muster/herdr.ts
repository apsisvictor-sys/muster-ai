/**
 * Muster Herdr integration — display metadata, lane observations and balanced
 * attention spans (plan §7, §5.8).
 *
 * Uses only the existing event contract of the vendor integration:
 * pi.events.emit("herdr:blocked", {active:true,label}) / {active:false}, counted
 * by herdr-agent-state.ts. Muster coalesces all tripped breaker groups into ONE
 * Muster-owned span and never decrements another extension's span. Display
 * metadata goes through `herdr pane report-metadata --source muster`.
 */

import { execFile } from "node:child_process";

export type HerdrPaneContext = {
	/** HERDR_ENV === "1" gates all Herdr calls. */
	enabled: boolean;
	paneId?: string;
	binPath?: string;
};

export function readHerdrContext(env: NodeJS.ProcessEnv): HerdrPaneContext {
	const context: HerdrPaneContext = { enabled: env?.HERDR_ENV === "1" };
	const paneId = env?.HERDR_PANE_ID;
	if (typeof paneId === "string" && paneId.length > 0) context.paneId = paneId;
	const binPath = env?.HERDR_BIN_PATH;
	if (typeof binPath === "string" && binPath.length > 0) context.binPath = binPath;
	return context;
}

/** One agent of `herdr agent list`: its name, state and the task token Muster reports on its pane. */
export type HerdrAgentRow = { name: string; status: string; task?: string };

/**
 * Herdr's agents, or undefined when outside Herdr or the call fails. Read-only:
 * the wait tool uses it to see a worker's agent go idle while its task is open.
 */
export function listHerdrAgents(ctx: HerdrPaneContext): Promise<HerdrAgentRow[] | undefined> {
	return new Promise((resolve) => {
		if (!ctx.enabled) return resolve(undefined);
		try {
			execFile(ctx.binPath ?? "herdr", ["agent", "list"], { timeout: LIST_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
				if (error !== null) return resolve(undefined);
				try {
					const parsed = JSON.parse(stdout) as { result?: { agents?: unknown } };
					const agents = parsed.result?.agents;
					if (!Array.isArray(agents)) return resolve(undefined);
					resolve(
						agents.flatMap((raw: unknown) => {
							const row = raw as { name?: unknown; agent_status?: unknown; tokens?: { task?: unknown } } | null;
							if (row === null || typeof row !== "object" || typeof row.name !== "string" || typeof row.agent_status !== "string") return [];
							const task = row.tokens?.task;
							return [{ name: row.name, status: row.agent_status, ...(typeof task === "string" && task !== "" && task !== "-" ? { task } : {}) }];
						}),
					);
				} catch {
					resolve(undefined);
				}
			});
		} catch {
			resolve(undefined);
		}
	});
}

export type MusterMetadata = {
	repo?: string;
	task?: string;
	files?: number;
	inboxPending?: number;
};

const REPORT_TIMEOUT_MS = 3000;
const LIST_TIMEOUT_MS = 4000;
/** Monotonic per-process report sequence (same shape as herdr-agent-state.ts). */
let reportSeq = Date.now() * 1000;

function nextReportSeq(): number {
	reportSeq += 1;
	return reportSeq;
}

function tokenText(value: string | undefined): string {
	return typeof value === "string" && value.length > 0 ? value : "-";
}

function tokenCount(value: number | undefined): string {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? String(Math.trunc(value)) : "0";
}

/**
 * Build the full argv (program included) for one Muster metadata report.
 * Exported for tests: the reported token shape is
 * repo=<alias>[+<extra>] task=<task-or-> files=<count> inbox=<count>.
 */
export function buildMetadataArgs(
	ctx: HerdrPaneContext,
	metadata: MusterMetadata,
	seq: number,
	additionalBindings = 0,
): string[] {
	const extra =
		typeof additionalBindings === "number" && Number.isFinite(additionalBindings) && additionalBindings > 0
			? `+${Math.trunc(additionalBindings)}`
			: "";
	const args = [
		"pane",
		"report-metadata",
		ctx.paneId ?? "",
		"--source",
		"muster",
		"--agent",
		"muster",
		"--seq",
		String(seq),
		"--title",
		"muster",
		"--token",
		`repo=${tokenText(metadata?.repo)}${extra}`,
		"--token",
		`task=${tokenText(metadata?.task)}`,
		"--token",
		`files=${tokenCount(metadata?.files)}`,
		"--token",
		`inbox=${tokenCount(metadata?.inboxPending)}`,
	];
	return [ctx.binPath ?? "herdr", ...args];
}

/**
 * Report display-only pane metadata with source=muster:
 * repo=<alias> task=<selected-write-task-or-> files=<declared-count> inbox=<pending-Pi-recording-count>
 * Fire-and-forget; never throws into the session. seq increments per report.
 */
export function reportMetadata(
	ctx: HerdrPaneContext,
	metadata: MusterMetadata,
	additionalBindings = 0,
): void {
	try {
		if (ctx === null || ctx === undefined || !ctx.enabled) return;
		if (ctx.paneId === undefined || ctx.paneId.length === 0) return;
		const argv = buildMetadataArgs(ctx, metadata ?? {}, nextReportSeq(), additionalBindings);
		execFile(argv[0], argv.slice(1), { timeout: REPORT_TIMEOUT_MS }, () => {
			// Display-only: failures are intentionally ignored.
		});
	} catch {
		// A display-only report must never disturb the session.
	}
}

/**
 * Coalesced, balanced attention span for breaker pauses. `ensure` emits one
 * active span (with label) when the Muster span is not yet open; `clear` emits
 * one inactive span only when all Muster groups are resumed/acknowledged.
 */
export class BreakerAttentionSpan {
	private isOpen = false;

	constructor(private readonly ctx: HerdrPaneContext) {}

	/** idempotent open */
	ensure(label: string, eventEmitter: { emit: (name: string, data: unknown) => void }): void {
		if (this.isOpen) return;
		if (this.ctx === null || this.ctx === undefined || !this.ctx.enabled) return;
		this.isOpen = true;
		eventEmitter.emit("herdr:blocked", { active: true, label });
	}

	/** idempotent close (only when no paused Muster groups remain) */
	clear(eventEmitter: { emit: (name: string, data: unknown) => void }): void {
		if (!this.isOpen) return;
		this.isOpen = false;
		eventEmitter.emit("herdr:blocked", { active: false });
	}

	get open(): boolean {
		return this.isOpen;
	}
}

/** Clear only Muster-owned metadata on shutdown (best effort, never throws). */
export function clearMetadata(ctx: HerdrPaneContext): void {
	try {
		if (ctx === null || ctx === undefined || !ctx.enabled) return;
		if (ctx.paneId === undefined || ctx.paneId.length === 0) return;
		execFile(
			ctx.binPath ?? "herdr",
			[
				"pane",
				"report-metadata",
				ctx.paneId,
				"--source",
				"muster",
				"--clear-token",
				"repo",
				"--clear-token",
				"task",
				"--clear-token",
				"files",
				"--clear-token",
				"inbox",
			],
			{ timeout: REPORT_TIMEOUT_MS },
			() => {
				// Shutdown cleanup: a missing lane or expired pane is benign.
			},
		);
	} catch {
		// Best effort only.
	}
}
