/**
 * Return a programme control record to the shape the release before R1 accepts.
 *
 * That release (`bc016f9`) validates a record strictly: any field, heartbeat
 * field or wake kind it does not know fails the whole record closed, and it never
 * resets one. R1 added `retiredAgents`, the heartbeat's `idleSince` and the
 * `frontier` wake; R1.5 added `rotation`, more heartbeat fields and the
 * `rotation` wake. After a rollback the old code would find the programme record
 * unreadable. This pure function removes exactly those additions and maps the two
 * new wake kinds to `watchdog` (an old kind with the same meaning: a hint to
 * look). The lists are frozen from the old release's validator on purpose; they
 * must not follow the current one.
 */

const BASE_RECORD_KEYS = new Set([
	"schemaVersion", "programmeId", "revision", "status", "runGeneration", "pauseReason", "enrolledSessions", "owner",
	"pendingWakes", "activeClaim", "executions", "reservations", "reservedPaths", "ceiling", "decisionRefs",
	"operatorActions", "lastOutcome", "lastHeartbeat", "createdAt", "updatedAt",
]);
const BASE_HEARTBEAT_KEYS = new Set(["pid", "sessionId", "generation", "at"]);
const BASE_WAKE_KINDS = new Set(["handoff", "delegate-completion", "operator-answer", "state-transition", "watchdog"]);

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function downgradeWakes(wakes: unknown, where: string, changes: string[]): unknown {
	if (!Array.isArray(wakes)) return wakes;
	return wakes.map((wake) => {
		if (!isObject(wake) || typeof wake["kind"] !== "string" || BASE_WAKE_KINDS.has(wake["kind"])) return wake;
		changes.push(`${where}: wake ${String(wake["sourceEventId"])} kind ${wake["kind"]} -> watchdog`);
		return { ...wake, kind: "watchdog" };
	});
}

/**
 * Return a programme decision file to the shape the release before R4 accepts.
 *
 * That reader requires `schemaVersion: 1` and refuses any field it does not
 * know, so a decision file this release wrote becomes unreadable after a
 * rollback even though the control record was downgraded. R4 added `reversible`,
 * `autoApplyAt`, `autoApplyHours` and `autoApplied` plus schema 2; this removes
 * exactly those and returns the file to schema 1. An applied card keeps the
 * outcome and provenance it already had (`answerRef`, `appliedOptionId`,
 * `appliedAt` all predate R4), and the `.before-downgrade` backup keeps the
 * whole new-release file beside it. No armed deadline survives: under the old
 * reader every card waits for the operator. The key list is frozen from the old
 * release's validator on purpose.
 */

/** The R4 additions; everything else in `DECISION_KEYS` predates R4 and stays. */
const BASE_DECISION_KEYS = new Set([
	"decisionId", "kind", "question", "options", "recommendation", "blockedTaskIds", "scopeRevision", "status",
	"answerRef", "appliedOptionId", "appliedAt", "createdAt", "updatedAt",
]);
const BASE_DECISION_SCHEMA_VERSION = 1;

export function downgradeDecisionsForBaseRelease(input: unknown): { record: unknown; changes: string[] } {
	if (!isObject(input)) return { record: input, changes: [] };
	const changes: string[] = [];
	if (input["schemaVersion"] === BASE_DECISION_SCHEMA_VERSION && Array.isArray(input["decisions"])
		&& (input["decisions"] as unknown[]).every((decision) => isObject(decision)
			&& Object.keys(decision).every((key) => BASE_DECISION_KEYS.has(key)))) {
		return { record: input, changes: [] };
	}
	const decisions = Array.isArray(input["decisions"]) ? (input["decisions"] as unknown[]).map((decision) => {
		if (!isObject(decision)) return decision;
		const base: Json = {};
		for (const [key, value] of Object.entries(decision)) {
			if (BASE_DECISION_KEYS.has(key)) base[key] = value;
			else changes.push(`removed decision ${String(decision["decisionId"])} field ${key}`);
		}
		return base;
	}) : input["decisions"];
	const record: Json = { ...input, schemaVersion: BASE_DECISION_SCHEMA_VERSION, decisions };
	if (input["schemaVersion"] !== BASE_DECISION_SCHEMA_VERSION) changes.push(`schemaVersion ${String(input["schemaVersion"])} -> ${BASE_DECISION_SCHEMA_VERSION}`);
	return { record, changes };
}

export function downgradeForBaseRelease(input: unknown): { record: unknown; changes: string[] } {
	if (!isObject(input)) return { record: input, changes: [] };
	const changes: string[] = [];
	const record: Json = {};
	for (const [key, value] of Object.entries(input)) {
		if (BASE_RECORD_KEYS.has(key)) record[key] = value;
		else changes.push(`removed ${key}`);
	}
	if (isObject(record["lastHeartbeat"])) {
		const beat: Json = {};
		for (const [key, value] of Object.entries(record["lastHeartbeat"] as Json)) {
			if (BASE_HEARTBEAT_KEYS.has(key)) beat[key] = value;
			else changes.push(`removed heartbeat ${key}`);
		}
		record["lastHeartbeat"] = beat;
	}
	record["pendingWakes"] = downgradeWakes(record["pendingWakes"], "pending", changes);
	if (isObject(record["activeClaim"])) {
		record["activeClaim"] = { ...(record["activeClaim"] as Json), wakes: downgradeWakes((record["activeClaim"] as Json)["wakes"], "claim", changes) };
	}
	// A record without these keys must come back exactly as it was.
	if (changes.length === 0) return { record: input, changes };
	return { record, changes };
}
