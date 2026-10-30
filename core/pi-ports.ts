/**
 * `core/pi-ports.ts` — the one owner of every capability the harness needs from
 * Pi's profile (blueprint §7, §6; RS1).
 *
 * The harness never imports Pi's profile, `memory/` or a Pi package at runtime
 * (RD1). A capability Pi provides is configured here, by the process's start
 * file, and read only when it is called. The store lives on
 * `globalThis[Symbol.for("pi.harness.ports")]` because Pi loads every extension
 * with its own jiti and `moduleCache: false`: a module-level store would leave
 * every other extension's copy unconfigured (RD4).
 *
 * Nothing here reads a port while its module loads. A port that was never
 * configured throws `PiPortMissing` at first use, never at import, so a start
 * file that forgets one fails the unit on its first call with a message naming
 * the port.
 *
 * The port interfaces are signatures copied from the callers that use them
 * today (S4, S5, S8, S12), so the adapter's real functions are checked against
 * them at their assignment in `harness-ports.ts` / `harness-gateway-ports.ts`.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Type-only references to the owners' own signatures (S4, S5, S8, S12). A type
// import is erased at runtime, so RD1's runtime rule is untouched, and the
// adapter's assignment proves the real functions fit.
// The shapes the ports carry are declared here (RS3 F3, D5). A type imported from
// `../../memory/...`, `../../extensions/...` or `../../health/...` cannot resolve from the
// repository, where those trees are Pi's profile and not part of the checkout. Every
// declaration below is the owner's own, copied; the owner's real functions are assigned to
// the ports in `harness-ports.ts`, so each copy meets its original where the two meet.

/** `memory/lib/claude-transcript.ts`: who a row belongs to. */
export type Speaker = "operator" | "agent" | "system";

/** `memory/lib/claude-transcript.ts`: one tool call of an assistant row and its paired result. */
export interface NormalizedAction {
	tool: string;
	input: Record<string, unknown>;
	ok: boolean | null;
	errorLine?: string;
}

/** `memory/lib/claude-transcript.ts`: one row of a normalized transcript. */
export interface NormalizedTranscriptMessage {
	role: "user" | "assistant";
	speaker?: Speaker;
	content: string;
	actions?: NormalizedAction[];
	uuid?: string;
	timestamp?: number;
}

/** `memory/lib/claude-transcript.ts`: a whole transcript. */
export interface NormalizedTranscript {
	sessionId: string;
	cwd: string;
	startTime: string;
	endTime: string;
	messages: NormalizedTranscriptMessage[];
	compactionSummary?: string;
	windowMessages?: NormalizedTranscriptMessage[];
	speakerCounts?: Record<Speaker, number>;
}

/** `memory/lib/claude-transcript.ts`: the last messages of a transcript, with their byte offsets. */
export interface NormalizedTranscriptTail {
	transcript: NormalizedTranscript;
	offsets: number[];
	reachedStart: boolean;
	olderInWindow: boolean;
	windowCount: number;
	bytesRead: number;
}

/** `memory/lib/claude-transcript.ts`: how far back a tail read goes. */
export interface TranscriptTailOptions {
	limit: number;
	endOffset?: number;
	blockBytes?: number;
	maxBytes?: number;
}

/** `extensions/lib/history-tool.ts`: what the two history tools return. */
export interface HistoryToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

/** `extensions/lib/history-tool.ts`: what a caller may fix for a search. */
export interface HistoryToolDeps {
	activeSessionId?: string;
	workspaceCandidates?: readonly unknown[];
	nowMs?: number;
	timeZone?: string;
}

/** `extensions/lib/context-lookup-tool.ts`: what a caller may fix for a lookup. */
export interface ContextLookupDeps {
	wikiRoot?: string;
}

/** `extensions/lib/context-lookup-tool.ts`: what the lookup returns. */
export interface ContextLookupToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: unknown;
	isError?: boolean;
}

/** The Pi-port key set (RD4, §7). */
export interface PiPorts {
	/** S10: the agent folder, set by the start file from its own location. */
	agentDir: string;
	/** S4: how a transcript is read (Pi's and Claude's), as memory exports it today. */
	transcripts: TranscriptReader;
	/** S5: the history tools, as `lib/history-tool.ts` exports them today. */
	history: HistoryPort;
	/** S5: the context lookup tool, as `lib/context-lookup-tool.ts` exports it today. */
	contextLookup: ContextLookupPort;
	/** S8: the Pi calls `provider-key.ts` makes, as Pi exports them. */
	credentials: CredentialReader;
	/** S12: memory's MCP server factory, loaded lazily as today. */
	memoryServer: MemoryServerFactory;
	/** S14: the classifier owner's two entry points, for the router's Jev step. */
	classifier: ClassifierPort;
	/** S14: the router's month, owned by telemetry. */
	routingBudget: RoutingBudgetPort;
	/** S14: the doctor's result file, by the doctor's own path rule. */
	doctor: DoctorPort;
}

/** S4. `readPiTranscript`, `readClaudeTranscript`, `listClaudeTranscriptFiles` and the two tail readers (command center D10), same names and types. */
export interface TranscriptReader {
	readPiTranscript(path: string, options?: { registry?: (sessionId: string) => boolean }): NormalizedTranscript | null;
	readClaudeTranscript(path: string, options?: { allMessages?: boolean; includeSystem?: boolean; includeActions?: boolean; withWindow?: boolean }): NormalizedTranscript | null;
	listClaudeTranscriptFiles(root: string, options?: { subagents?: boolean }): string[];
	readPiTranscriptTail(path: string, options: TranscriptTailOptions & { registry?: (sessionId: string) => boolean }): NormalizedTranscriptTail | null;
	readClaudeTranscriptTail(path: string, options: TranscriptTailOptions): NormalizedTranscriptTail | null;
}

/** S5. The two history entry points, same names and signatures as the tools export them. */
export interface HistoryPort {
	executeHistoryRead(rawParams: unknown, deps?: HistoryToolDeps): HistoryToolResult;
	executeHistorySearch(rawParams: unknown, deps?: HistoryToolDeps): HistoryToolResult;
}

/** S5. The context lookup entry point, same name and signature as the tool exports it. */
export interface ContextLookupPort {
	executeContextLookup(rawParams: unknown, deps?: ContextLookupDeps): Promise<ContextLookupToolResult>;
}

/**
 * S14. The classifier owner's two entry points (`extensions/lib/classifier.ts`), with the
 * shapes they take and return. The Jev step calls them; nothing here is a second
 * implementation of the classifier, only the signature it is reached by.
 */
export type JsonState = Record<string, unknown>;

export type ClassifierQuestionDef =
	| { type: "choice"; instructions: string; criteria: Record<string, string> }
	| { type: "score"; instructions: string; criteria: string[] }
	| { type: "bool"; instructions: string; criteria: { true: string; false: string } };

export interface QuestionSet {
	id: string;
	version: number;
	questions: Record<string, ClassifierQuestionDef>;
}

export type ClassifierAnswerLike =
	| { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
	| { type: "score"; score: number; confidence: number }
	| { type: "bool"; probability: number };

export interface ClassifierResultLike {
	stopReason: string;
	errorMessage?: string;
	answers: Record<string, ClassifierAnswerLike>;
	usage?: { input?: number; output?: number; cost?: { total?: number } };
}

export interface ClassifierRegistry {
	getModelOfType(type: "classifier", provider: string, modelId: string): unknown;
	classify(model: never, context: { state: JsonState; questions: Record<string, ClassifierQuestionDef> }, options?: { signal?: AbortSignal }): Promise<ClassifierResultLike>;
}

export type ClassifierBucket = "classifier" | "routing";

export interface ClassifierCallRecord {
	at: string;
	questionSet: string;
	setVersion: number;
	model: string;
	caller: string;
	bucket: ClassifierBucket;
	stopReason: string;
	answers: Record<string, ClassifierAnswerLike>;
	inputTokens: number | null;
	outputTokens: number | null;
	costUsd: number | null;
	latencyMs: number;
	stateBytes: number;
	error?: string;
	ceilingUsd?: number;
}

export interface ClassifierBudgetPort {
	spentSince(monthStartIso: string): number | undefined;
	record(record: ClassifierCallRecord): void;
}

export interface ClassifierPool {
	roles?: Record<string, readonly string[] | undefined>;
	ceilings?: Partial<Record<ClassifierBucket, { usdPerMonth: number }>>;
}

export type ClassifyOutcome = { ok: true; answers: Record<string, ClassifierAnswerLike>; record: ClassifierCallRecord } | { ok: false; answers: Record<string, never>; record: ClassifierCallRecord };

export interface ClassifyOptions {
	caller: string;
	bucket?: ClassifierBucket;
	sink?: (record: ClassifierCallRecord) => void;
	signal?: AbortSignal;
	questionsDir?: string;
	budget?: ClassifierBudgetPort;
	now?: () => Date;
}

/** S14. The classifier owner, reached as a port by the router's Jev step. */
export interface ClassifierPort {
	closedChoiceSet(id: string, version: number, questions: Record<string, { instructions: string; criteria: Record<string, string> }>): QuestionSet;
	classifyQuestionSet(registry: ClassifierRegistry, pool: ClassifierPool, set: QuestionSet, state: JsonState, options: ClassifyOptions): Promise<ClassifyOutcome>;
}

/**
 * S14. The router's month, read and recorded by the telemetry owner
 * (`extensions/telemetry-stats/db.ts`). The path, the connection and the bucket stay the
 * owner's; the port hands back the budget port the Jev step spends against.
 */
export interface RoutingBudgetPort {
	(): Promise<ClassifierBudgetPort>;
}

/**
 * S14. The doctor's result file (`health/doctor.ts`), by the doctor's own path rule: a
 * second reader of liveness is exactly what the panel must not do.
 */
export interface DoctorPort {
	resultFile(): Promise<string>;
}

/**
 * S8. The Pi calls `provider-key.ts` makes, as Pi exports them (SK0-R6's
 * `findEnvKeys`, the fork's `getProviderEnvValue`, and Pi's stored-credential
 * reader). The key logic itself stays in `provider-key.ts`; only Pi's storage
 * reader, name table and env lookup travel through here.
 */
export interface CredentialReader {
	findEnvKeys(provider: string, env: Record<string, string>): string[] | undefined;
	getProviderEnvValue(name: string): string | undefined;
	readStoredCredential(provider: string): unknown;
}

/** S12. Memory's MCP server factory, loaded by the Pi adapter exactly as it is today. */
export type MemoryServerFactory = () => Promise<{ createMemoryServer: () => MemoryServerLike }>;

/** The part of Pi's `McpServer` the gateway's knowledge bridge uses: it connects a transport. */
export interface MemoryServerLike {
	connect(transport: unknown): Promise<void>;
}

const PORT_SLOT = Symbol.for("pi.harness.ports");

type PortSlot = { ports?: Partial<PiPorts> };

function portSlot(): PortSlot {
	const host = globalThis as unknown as { [PORT_SLOT]?: PortSlot };
	return (host[PORT_SLOT] ??= {});
}

/** Thrown at first use of a port the process's start file did not configure. */
export class PiPortMissing extends Error {
	readonly port: keyof PiPorts;
	constructor(port: keyof PiPorts) {
		super(`PiPortMissing: ${port} was not configured by this process's start file`);
		this.port = port;
		this.name = "PiPortMissing";
	}
}

/**
 * Store the ports a start file provides. Configuring the same values twice is a
 * no-op, so a second import of this module (one per jiti copy) changes nothing.
 */
export function configurePiPorts(ports: Partial<PiPorts>): void {
	const slot = portSlot();
	const next: Partial<PiPorts> = { ...(slot.ports ?? {}) };
	for (const [name, value] of Object.entries(ports) as [keyof PiPorts, unknown][]) {
		if (value !== undefined) (next as Record<string, unknown>)[name] = value;
	}
	slot.ports = next;
}

/** Read one port. Throws `PiPortMissing` naming the port when it was never configured. */
export function piPort<K extends keyof PiPorts>(name: K): PiPorts[K] {
	const value = portSlot().ports?.[name];
	if (value === undefined) throw new PiPortMissing(name);
	return value as PiPorts[K];
}

/**
 * S10. The agent folder a start file stands in, from that file's own location: a
 * file at `<agentDir>/extensions/<package>/<file>` is two levels below the agent
 * dir, and so is the prebuilt `claude-hook` bundle. The process's start file
 * calls this; nothing else derives a path into Pi's profile from its own
 * location.
 */
export function agentDirOf(moduleUrl: string): string {
	return resolve(dirname(fileURLToPath(moduleUrl)), "..", "..");
}

/**
 * S10. The agent folder the start file configured. Same as `piPort("agentDir")`:
 * harness code never derives a path into Pi's profile or state from its own
 * location, because after the switch-over its own location is the harness repo.
 */
export function piAgentDir(): string {
	return piPort("agentDir");
}

/** S13. Muster's state root; the one reader of `PI_MUSTER_STATE_DIR`. */
export function musterStateDir(): string {
	const override = process.env.PI_MUSTER_STATE_DIR?.trim();
	return override ? resolve(override) : join(piAgentDir(), "state", "muster");
}

/**
 * S10. The `muster` launcher under the configured agent folder. It was a
 * module-level constant derived from `resume-timer.ts`'s own location; a
 * function, so nothing reads a location while a module loads.
 */
export function musterLauncher(): string {
	return join(piAgentDir(), "extensions", "muster", "launchers", "muster");
}

/**
 * S6. The members of Pi's `ExtensionContext` that `event-wake.ts` uses: it only
 * carries the value through to a policy's `admit`. Pi's real context fits it.
 */
export type ExtensionContextLike = unknown;

/**
 * S6. The members of Pi's `ExtensionAPI` that `event-wake.ts` uses. Structural,
 * so core imports no Pi package; the typecheck proves Pi's real object fits it.
 */
export interface ExtensionApiLike {
	sendMessage(message: unknown, delivery?: unknown): unknown;
	on(event: string, handler: (event: unknown, ctx: ExtensionContextLike) => void): void;
	/** Pi's own event-bus facade, keyed on rather than the extension instance. */
	events?: object;
}
