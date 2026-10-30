/**
 * Lead election policy (R1, AM1.3–AM1.5): whoever the operator drove last leads the
 * project.
 *
 * Pure policy only. This module reads no state and writes none: the control
 * store owns ownership, `projects.ts` owns project identity, and the wiring in
 * `index.ts` calls the two together. What lives here is the decision of WHEN a
 * session may take ownership, so the rule is one testable function instead of
 * prose in a skill:
 *
 * - a session becomes the orchestrator at its first orchestration act, and
 *   only inside a run that started from the operator's own input (his keyboard, or
 *   his bound Discord account);
 * - reads, chat, plain code edits, runs started by a relay, peer message,
 *   continuation or watchdog, and worker lanes never take ownership.
 */

// ─── Run origin ──────────────────────────────────────────────────────────────

/** Runtime-authored identity. `model` is the provider-qualified label used by the leader metadata owner. */
export type RuntimeActorIdentity = { sessionId: string; provider: string; model: string; harness: string };
export function isRuntimeActorIdentity(value: unknown): value is RuntimeActorIdentity {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	const fields = ["sessionId", "provider", "model", "harness"];
	return Object.keys(row).every((key) => fields.includes(key)) && fields.every((key) => typeof row[key] === "string" && (row[key] as string).trim() !== "")
		&& (row.model as string).startsWith(`${row.provider}/`) && (row.model as string).length > (row.provider as string).length + 1;
}

export type RunOrigin = "operator" | "automatic";
export type InputSource = "interactive" | "rpc" | "extension";

/**
 * Tracks where the current agent run came from. An operator input upgrades a
 * run that is already in progress (the operator stepped in); an automatic message
 * never downgrades one. A run with no recorded origin is automatic, so an
 * unknown start can never take ownership.
 */
export function createRunOriginTracker() {
	let pending: RunOrigin | undefined;
	let current: RunOrigin | undefined;
	let active = false;
	const automaticGroups = new Set<string>();

	function note(origin: RunOrigin): void {
		if (active) {
			if (origin === "operator") current = "operator";
			return;
		}
		pending = pending === "operator" || origin === "operator" ? "operator" : "automatic";
	}

	return {
		/** A user input event. Only a human source (keyboard, rpc) counts as the operator. */
		noteInput(source: InputSource): void {
			note(source === "extension" ? "automatic" : "operator");
		},
		/** A conversation from the operator's bound Discord account. */
		noteOperatorRelay(): void {
			note("operator");
		},
		/**
		 * A relay, continuation, frontier or watchdog message, or an admitted
		 * event wake. The group names which no-progress loop this run belongs to,
		 * so the breaker can trip that one group (a wake producer trips its own
		 * `event:<origin>`, never another's).
		 */
		noteAutomatic(group?: string): void {
			note("automatic");
			if (group !== undefined && group !== "") automaticGroups.add(group);
		},
		/** Groups recorded for the run in progress; read once at the run's end. */
		takeAutomaticGroups(): string[] {
			const groups = [...automaticGroups];
			automaticGroups.clear();
			return groups;
		},
		runStarted(): void {
			// Pi fires agent_start for every agent loop of one run: a retry, a
			// compaction and a queued continue each start another loop. The origin
			// belongs to the run, so only the first start decides it.
			if (active) return;
			current = pending ?? "automatic";
			pending = undefined;
			active = true;
		},
		runSettled(): void {
			active = false;
			current = undefined;
		},
		/** The origin of the run in progress; `undefined` between runs. */
		current(): RunOrigin | undefined {
			return active ? current : undefined;
		},
	};
}

// ─── Orchestration acts ──────────────────────────────────────────────────────

export type OrchestrationAct = "create" | "assign" | "accept" | "decline" | "release" | "finish" | "launch" | "close" | "integrate";

const HERDR_LAUNCH = /(^|[;&|]\s*|\n\s*)herdr\s+(pane\s+split|agent\s+start|workspace\s+create)\b/;
const HERDR_CLOSE = /(^|[;&|]\s*|\n\s*)herdr\s+(pane\s+close|workspace\s+close|agent\s+send-keys)\b/;
const GIT_INTEGRATE = /(^|[;&|]\s*|\n\s*)git\s+(merge|cherry-pick)\b(?!.*--abort)/;
const SHELL_TOOLS = new Set(["bash", "powershell", "run_code"]);

/**
 * Classify a tool call as an orchestration act: creating, assigning, accepting
 * or finishing a task, launching or closing a worker, or integrating. Reads,
 * chat and plain code edits are not acts. A shell command is an act only when
 * the command itself starts with the verb, never when it appears as text.
 */
export function orchestrationActOf(event: { toolName: string; input?: Record<string, unknown> }): OrchestrationAct | undefined {
	const input = event.input ?? {};
	switch (event.toolName) {
		case "muster_start":
			return "create";
		case "muster_finish":
			return "finish";
		case "muster_transfer": {
			const action = input["action"];
			if (action === "assign" || action === "reassign") return "assign";
			if (action === "accept") return "accept";
			if (action === "decline") return "decline";
			if (action === "release") return "release";
			return undefined;
		}
	}
	if (SHELL_TOOLS.has(event.toolName)) {
		const command = typeof input["command"] === "string" ? (input["command"] as string) : "";
		if (HERDR_LAUNCH.test(command)) return "launch";
		if (HERDR_CLOSE.test(command)) return "close";
		if (GIT_INTEGRATE.test(command)) return "integrate";
	}
	return undefined;
}

/**
 * A worker lane is launched with its own task id in the environment. A parent
 * may carry a stable CONCORD_AGENT_ID, so that variable alone proves nothing:
 * but a launcher-assigned id that is not the project's mailbox names a lane, even
 * one launched without a task id (a reused or hand-launched lane). Without a
 * known mailbox only the task variable counts.
 */
export function isWorkerSession(env: Record<string, string | undefined>, projectMailbox?: string): boolean {
	if (typeof env["CONCORD_TASK"] === "string" && env["CONCORD_TASK"]!.trim() !== "") return true;
	const agentId = env["CONCORD_AGENT_ID"]?.trim();
	return projectMailbox !== undefined && agentId !== undefined && agentId !== "" && agentId !== projectMailbox;
}

export type LeadDecision = "admit" | "lead" | "refuse-automatic";

export function decideLead(input: {
	act: OrchestrationAct | undefined;
	worker: boolean;
	origin: RunOrigin | undefined;
	isOwner: boolean;
}): LeadDecision {
	if (input.act === undefined || input.worker || input.isOwner) return "admit";
	return input.origin === "operator" ? "lead" : "refuse-automatic";
}

// ─── Notices (AM1.5, AM1.6) ──────────────────────────────────────────────────

export function formatClock(at: Date): string {
	return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

export function leadingNotice(project: string): string {
	return `Leading ${project}`;
}

export function supersededNotice(input: { project: string; sessionName: string; at: Date }): string {
	return `${input.project} moved to session '${input.sessionName}' at ${formatClock(input.at)}. This session no longer orchestrates it.`;
}

/** The one line posted to the project's Discord thread on every takeover. */
export function connectedLine(input: { sessionName: string; model: string; startedAt: Date }): string {
	return `Now connected to '${input.sessionName}' (${input.model}), started ${formatClock(input.startedAt)}. Previous orchestrator disconnected.`;
}

/**
 * Fixed reply to `status` in a project's Discord thread while no orchestrator is
 * running. No session exists to answer, so the text is deterministic and the
 * Hermes bridge sends this same wording (AM1.6). After an explicit off the bridge
 * drops messages instead of keeping them, so the reply says so; otherwise they
 * are kept and replayed with the next message once an orchestrator runs.
 */
export function noOwnerStatusText(project: string, state: "absent" | "off" = "absent"): string {
	if (state === "off") return `${project} is off. Messages sent here are not kept. Run /lead inside the repository to turn it back on.`;
	return `No orchestrator is running for ${project}. To start one, open pi anywhere and say "continue ${project}", or run /lead inside the repository. Messages sent here are kept and delivered with the first message you send once an orchestrator is running.`;
}

/** The orchestrator session is auto-named so it is easy to find in `pi -r`. */
export function orchestratorSessionName(project: string): string {
	return `${project} orchestrator`;
}
