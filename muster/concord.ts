/**
 * Muster Concord client — one MCP connection per repository binding (plan §5.4).
 *
 * Owns: launcher spawn with the exact Node + D5 environment, initialization,
 * request serialization per connection, live-schema adaptation (actor stripping
 * + muster_repo routing field), structured-content validation, and MCP isError
 * → real error conversion. Live schemas are treated as immutable after
 * registration; requests are cloned per call.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export type ConcordToolDef = {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
};

export type ConcordToolResult = {
	content: Array<{ type: string; text?: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
};

export type CallOptions = {
	timeoutMs?: number;
	signal?: AbortSignal;
};

export type ConcordConnectOptions = {
	/** Absolute path of the concord-mcp launcher script. */
	launcherMcp: string;
	/** Primary repo root passed as CONCORD_REPO_ROOT (workspace resolution). */
	repoRoot: string;
	/** Binding transport id passed as CONCORD_AGENT_ID (session identity). */
	agentId: string;
	/** Binding cwd; the launcher resolves entries relative to itself. */
	cwd?: string;
	/** Extra environment (e.g. D5 verification flags for tests). */
	extraEnv?: Record<string, string>;
	connectTimeoutMs?: number;
};

/** Base environment every Concord process gets (plan D5). */
export function concordEnvironment(extra: Record<string, string> = {}): Record<string, string> {
	return {
		CONCORD_TELEMETRY_DISABLED: "1",
		CONCORD_NO_UPDATE_CHECK: "1",
		...extra,
	};
}

/** Serialize calls per MCP connection; expired queued work must not mutate. */
class RequestSerializer {
	private tail: Promise<unknown> = Promise.resolve();

	run<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.tail.then(fn, fn);
		// Keep the chain alive regardless of individual failures.
		this.tail = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}
}

/** Concord's own SQLite store refused a write because another process held it. Nothing was applied. */
export const DATABASE_LOCKED = /database is locked|SQLITE_BUSY/i;

/** Waits between retries of a locked Concord call: four retries, 3.75 s in all, inside the 20 s call timeout. */
const LOCKED_RETRY_DELAYS_MS = [250, 500, 1000, 2000];

/**
 * Run one Concord call again when Concord answers `database is locked` (F7: 4
 * lane reports lost to it). The refusal is SQLITE_BUSY from a write that never
 * ran, so a retry cannot apply anything twice. Any other error passes through.
 */
export async function retryWhenLocked<T>(
	fn: () => Promise<T>,
	delaysMs: readonly number[] = LOCKED_RETRY_DELAYS_MS,
	sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await fn();
		} catch (error) {
			const wait = delaysMs[attempt];
			if (wait === undefined || !DATABASE_LOCKED.test(error instanceof Error ? error.message : String(error))) throw error;
			await sleep(wait);
		}
	}
}

export class ConcordClient {
	private client?: Client;
	private transport?: StdioClientTransport;
	private serializer = new RequestSerializer();
	readonly repoRoot: string;
	readonly agentId: string;
	private closed = false;

	private constructor(
		readonly options: ConcordConnectOptions,
		private readonly childPid: number,
	) {
		this.repoRoot = options.repoRoot;
		this.agentId = options.agentId;
	}

	/** Spawn the launcher and initialize the MCP session. */
	static async connect(options: ConcordConnectOptions): Promise<ConcordClient> {
		if (!existsSync(options.launcherMcp)) {
			throw new Error(`muster: Concord MCP launcher not found: ${options.launcherMcp}`);
		}
		const env = {
			...process.env,
			...concordEnvironment(),
			...(options.extraEnv ?? {}),
			CONCORD_REPO_ROOT: options.repoRoot,
			CONCORD_AGENT_ID: options.agentId,
		};
		const transport = new StdioClientTransport({
			command: options.launcherMcp,
			args: [],
			cwd: options.cwd ?? process.cwd(),
			env: env as Record<string, string>,
		});
		const client = new Client({ name: "muster-pi", version: "1.0.0" });
		const timeout = options.connectTimeoutMs ?? 15000;
		await client.connect(transport, { timeout });
		const pid = (transport as unknown as { pid?: number }).pid ?? -1;
		const instance = new ConcordClient(options, pid);
		instance.client = client;
		instance.transport = transport;
		return instance;
	}

	get pid(): number {
		return this.childPid;
	}

	async listTools(options?: CallOptions): Promise<ConcordToolDef[]> {
		if (this.closed || !this.client) {
			throw new Error("muster: Concord connection closed (listTools)");
		}
		return this.serializer.run(async () => {
			const client = this.client!;
			const result = await client.listTools({}, {
				timeout: options?.timeoutMs ?? 20000,
				signal: options?.signal,
			});
			return (result.tools ?? []) as ConcordToolDef[];
		});
	}

	/**
	 * Call one public workflow tool. Serialization: one request at a time per
	 * connection. A request that times out or is cancelled must not mutate later
	 * — the SDK raises McpError before the result is applied, and Concord applies
	 * mutations only when its handler completes.
	 */
	async callTool(
		name: string,
		args: Record<string, unknown>,
		options?: CallOptions,
	): Promise<ConcordToolResult> {
		if (this.closed || !this.client) {
			throw new Error(`muster: Concord connection closed (callTool ${name})`);
		}
		return this.serializer.run(async () => {
			const client = this.client!;
			// Clone so queued mutation after a cancelled sibling cannot see later patches.
			const params = { name, arguments: structuredClone(args) };
			return retryWhenLocked(async () => {
				const result = (await client.callTool(params, undefined, {
					timeout: options?.timeoutMs ?? 20000,
					signal: options?.signal,
				})) as ConcordToolResult;
				if (result?.isError === true) {
					const text = (result.content ?? [])
						.filter((c) => c.type === "text")
						.map((c) => c.text ?? "")
						.join("\n");
					throw new Error(`muster: ${name} failed: ${text || "unknown Concord error"}`, {
						cause: result,
					});
				}
				return result;
			});
		});
	}

	private raw(method: string, params: unknown, options?: CallOptions): Promise<unknown> {
		if (this.closed || !this.client) {
			throw new Error(`muster: Concord connection closed (${method})`);
		}
		return this.serializer.run(async () => {
			const client = this.client!;
			const request = { method, params } as never;
			return (await client.request(request, undefined, {
				timeout: options?.timeoutMs ?? 20000,
				signal: options?.signal,
			})) as unknown;
		});
	}

	async readResource(
		uri: string,
		options?: CallOptions,
	): Promise<unknown> {
		if (this.closed || !this.client) {
			throw new Error(`muster: Concord connection closed (readResource)`);
		}
		return this.serializer.run(async () => {
			const client = this.client!;
			const result = await client.readResource({ uri }, {
				timeout: options?.timeoutMs ?? 20000,
				signal: options?.signal,
			});
			const text = result?.contents?.[0]?.text;
			return text === undefined ? undefined : JSON.parse(text);
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		try {
			await this.client?.close();
		} catch {
			// Transport teardown races are benign; the child is killed below.
		}
		this.transport?.close?.();
		// Bounded force cleanup of the spawned launcher process group.
		if (this.childPid > 0) {
			try {
				process.kill(-this.childPid, "SIGTERM");
			} catch {
				try {
					process.kill(this.childPid, "SIGTERM");
				} catch {
					/* already gone */
				}
			}
		}
	}
}

// ─── Schema adaptation (plan §5.4 rule 2) ────────────────────────────────────

const MUTATION_TOOLS = new Set(["start_work", "update_work", "transfer_work", "finish_work"]);

export type AdaptedToolSchema = {
	concordName: string;
	schema: Record<string, unknown>;
};

/**
 * Clone the live schema and adapt it for the Pi tool surface:
 * - the four mutation tools lose the actor `agent_id` property (the connection's
 *   CONCORD_AGENT_ID session identity injects the actor server-side);
 * - inspect keeps `agent_id` as an inspection selector;
 * - every tool gains the optional routing field `muster_repo`.
 */
export function adaptToolSchema(live: ConcordToolDef): AdaptedToolSchema | undefined {
	const schema = structuredClone(live.inputSchema) as {
		type?: string;
		properties?: Record<string, unknown>;
		required?: string[];
		additionalProperties?: unknown;
	};
	if (schema.type !== "object" || typeof schema.properties !== "object") {
		return undefined;
	}
	const props = { ...schema.properties };
	if (MUTATION_TOOLS.has(live.name)) {
		delete props["agent_id"];
	}
	if (live.name === "transfer_work") {
		// R2: the offer's verification facts and the accept flag are Muster-owned.
		// They are stripped before the call reaches Concord and recorded in the
		// control record instead (see merge-queue.ts).
		props["base_sha"] = { type: "string", description: "Offer only: the integration commit your branch started from." };
		props["head_sha"] = { type: "string", description: "Offer only: the commit your branch now points at." };
		props["evidence"] = {
			type: "array",
			description: "Offer only: the guarded-run logs that verified this head. Each entry names the checkout root, the commit the run ran against, and that checkout's content fingerprint.",
			items: {
				type: "object",
				properties: {
					log: { type: "string", description: "Path of the guarded-run log." },
					root: { type: "string", description: "Checkout the run consumed." },
					head_sha: { type: "string", description: "Commit the run ran against." },
					fingerprint: { type: "string", description: "Content fingerprint of that checkout when the run started." },
				},
				required: ["log", "root", "head_sha", "fingerprint"],
			},
		};
		props["integrate"] = {
			type: "boolean",
			description: "Accept only: run the merge queue after accepting. It fast-forwards the integration checkout when the base is still its head and the evidence is fresh, returns the offer to the worker when the head moved, and refuses stale evidence or a risky path with no independent review verdict.",
		};
		props["verdict"] = { type: "string", description: "Review only: 'approve' or 'reject' for the head you reviewed.", enum: ["approve", "reject"] };
		props["note"] = { type: "string", description: "Reassign only: why the work went back to the worker." };
	}
	props["muster_repo"] = {
		type: "string",
		description:
			"Optional repository alias to route this call when this session has multiple joined repositories. Omit when only one repo is joined.",
	};
	// The runtime knows which model and harness is running; a model that guesses
	// them records a false identity (R1 item 6). `muster_start` fills both in.
	if (live.name === "start_work") {
		delete props["model"];
		delete props["kind"];
	}
	const required = (schema.required ?? []).filter(
		(field) => field !== "agent_id" && !(live.name === "start_work" && field === "kind"),
	);
	const adapted: Record<string, unknown> = {
		...schema,
		properties: props,
		required,
	};
	return { concordName: live.name, schema: adapted };
}

/** Concord tool name for a Muster tool name (plan: five fixed mappings). */
export function concordNameFor(musterName: string): string {
	switch (musterName) {
		case "muster_start":
			return "start_work";
		case "muster_inspect":
			return "inspect_work";
		case "muster_update":
			return "update_work";
		case "muster_transfer":
			return "transfer_work";
		case "muster_finish":
			return "finish_work";
		default:
			throw new Error(`muster: unknown tool ${musterName}`);
	}
}

// ─── Structured content validation (plan §5.4 rule 3) ────────────────────────

export type TaskFields = {
	task_id?: unknown;
	status?: unknown;
	version?: unknown;
	agent_id?: unknown;
	assigned_agent_id?: unknown;
	updated_at?: unknown;
};

const TASK_STATUSES = new Set([
	"proposed",
	"assigned",
	"active",
	"blocked",
	"handoff_offered",
	"handed_off",
	"review_ready",
	"complete",
	"closed",
]);

/** Message delivery statuses used by update_work prompt/reply results. */
const MESSAGE_STATUSES = new Set(["pending", "delivered", "failed", "replied"]);

/**
 * Validate the task/owner/version fields Muster reads from structuredContent
 * before any code path uses them. Throws on shape violations so callers never
 * act on malformed data. Message-scope results (update_work prompt/reply)
 * carry message statuses, not task statuses.
 */
export function validateTaskFields(
	scope: string,
	raw: unknown,
	statusKind: "task" | "message" = "task",
): TaskFields {
	if (raw === null || typeof raw !== "object") {
		throw new Error(`muster: ${scope} returned no structured content`);
	}
	const obj = raw as Record<string, unknown>;
	if (
		obj.task_id !== undefined &&
		obj.task_id !== null &&
		(typeof obj.task_id !== "string" || obj.task_id.length === 0)
	) {
		throw new Error(`muster: ${scope} returned malformed task_id`);
	}
	if (obj.status !== undefined) {
		const allowed = statusKind === "message" ? MESSAGE_STATUSES : TASK_STATUSES;
		if (typeof obj.status !== "string" || !allowed.has(obj.status)) {
			throw new Error(
				`muster: ${scope} returned unknown ${statusKind} status ${String(obj.status)}`,
			);
		}
	}
	if (obj.version !== undefined) {
		const v = obj.version;
		if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
			throw new Error(`muster: ${scope} returned malformed version ${String(v)}`);
		}
	}
	return obj as TaskFields;
}

/** Extract nested task detail objects from inspect_work task scope. */
export function taskDetailOf(structured: Record<string, unknown> | undefined): {
	task?: Record<string, unknown>;
	pending_handoff?: Record<string, unknown> | null;
	ownership_history?: unknown[];
	overlaps?: unknown[];
	messages?: unknown[];
	updates?: unknown[];
} {
	if (!structured || typeof structured !== "object") return {};
	const s = structured as Record<string, unknown>;
	return {
		task: (s.task ?? undefined) as Record<string, unknown> | undefined,
		pending_handoff: (s.pending_handoff ?? null) as Record<string, unknown> | null,
		ownership_history: (s.ownership_history ?? []) as unknown[],
		overlaps: (s.overlaps ?? []) as unknown[],
		messages: (s.messages ?? []) as unknown[],
		updates: (s.updates ?? []) as unknown[],
	};
}
