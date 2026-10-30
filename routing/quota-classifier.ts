/**
 * The single owner of two readings of a failed request, tagged by nothing but its own text:
 *
 *   - `classifyQuota`: "is this error a quota wall". It names no provider: the wording it
 *     recognises is data (`QuotaShape`), shipped in provider-pool.json. A plain 429 or
 *     rate_limit_error is not a quota signal; only a shape says so.
 *   - `classifyFailure`: "should this request move to the next ref, and is the provider
 *     walled". It reads the status, the provider's own error code and, last, the wording
 *     (ROUTERFAIL, Henry 2026-10-29). Quota wording stays `classifyQuota`'s, so there is one
 *     vocabulary and not two.
 *
 * The two answers differ on purpose. A rejected or expired credential, an inactive plan, a spent
 * allowance and an endpoint that says it is unavailable are walls: the ref cannot be used again
 * until the wall lifts. Bare capacity - a 429, a 503, "overloaded" - moves *this* request to the
 * next ref without walling anything, because the same ref usually answers again a moment later,
 * and because a wall is what the pool parks a provider under. A shape the pool ships is always a
 * wall: the file said so, and its wording outranks this module's own reading.
 */

/** How to read when a wall lifts from the error text. Capture group 1 is the value. */
export type QuotaResetRule =
	/** Group 1 is an ISO-8601 timestamp that carries its own zone. */
	| { kind: "iso"; pattern: string }
	/** Group 1 is `YYYY-MM-DD HH:MM:SS` with no zone in the text; `zone` is "utc" or an offset such as "+08:00". */
	| { kind: "datetime"; pattern: string; zone: string }
	/** Group 1 is a number and group 2 its unit (min, h, hour, d, day), counted from now. */
	| { kind: "relative"; pattern: string };

export interface QuotaShape {
	id: string;
	/** Regular expression, case-insensitive, tested against the error text. */
	match: string;
	/** The reset reading is a guess, not shown from evidence. */
	assumed?: boolean;
	reset?: QuotaResetRule;
}

export type QuotaClassification =
	| { quota: false }
	| { quota: true; shapeId: string; /** Epoch ms from the error text, when it carries one. */ resetAt?: number; assumed?: boolean };

const UNIT_MS: Record<string, number> = { m: 60_000, min: 60_000, h: 3_600_000, hr: 3_600_000, hour: 3_600_000, d: 86_400_000, day: 86_400_000 };

function compile(source: string): RegExp | undefined {
	try {
		return new RegExp(source, "i");
	} catch {
		return undefined;
	}
}

function readReset(rule: QuotaResetRule, text: string, now: number): number | undefined {
	const found = compile(rule.pattern)?.exec(text);
	if (!found?.[1]) return undefined;
	let at: number;
	if (rule.kind === "iso") {
		at = Date.parse(found[1]);
	} else if (rule.kind === "datetime") {
		const zone = rule.zone.toLowerCase() === "utc" ? "Z" : rule.zone;
		at = Date.parse(`${found[1].replace(" ", "T")}${zone}`);
	} else {
		const unit = UNIT_MS[(found[2] ?? "").toLowerCase()];
		const amount = Number(found[1]);
		at = unit && Number.isFinite(amount) ? now + amount * unit : Number.NaN;
	}
	return Number.isFinite(at) ? at : undefined;
}

export function classifyQuota(message: { stopReason?: string; errorMessage?: string }, shapes: readonly QuotaShape[], now: number): QuotaClassification {
	if (message.stopReason !== "error" || !message.errorMessage) return { quota: false };
	for (const shape of shapes) {
		if (!compile(shape.match)?.test(message.errorMessage)) continue;
		const resetAt = shape.reset ? readReset(shape.reset, message.errorMessage, now) : undefined;
		return { quota: true, shapeId: shape.id, ...(resetAt !== undefined ? { resetAt } : {}), ...(shape.assumed ? { assumed: true } : {}) };
	}
	return { quota: false };
}

// ─── The failover reading (ROUTERFAIL) ──────────────────────────────────────

/** What a failed request says about the ref that answered it. `none`: nothing this module can read. */
export type FailureKind = "auth" | "expiry" | "entitlement" | "usage" | "unavailable" | "capacity" | "none";

/** Where the id came from: the pool's own shape, or a reading of the answer's status, code or wording. */
export type FailureSource = "shape" | "expiry" | "status" | "code" | "wording";

export interface FailureClassification {
	/** Record the wall: the ref is not used again until the wall lifts. */
	wall: boolean;
	/** Move this request to the next ref in the chain. True for every wall, and for capacity. */
	failover: boolean;
	kind: FailureKind;
	/** The pool shape id, or this module's own (`expired-credential`, `http-401`, `capacity-429`). */
	id?: string;
	source?: FailureSource;
	status?: number;
	code?: string;
	resetAt?: number;
	assumed?: boolean;
}

/** The statuses that say the request cannot succeed as sent. */
const AUTH_STATUSES = [401, 403];
/** The statuses that say the provider is out of capacity right now. */
const CAPACITY_STATUSES = [408, 429, 500, 502, 503, 504];

/** The provider's own codes, in the body or bare, that mean a rejected credential. */
const AUTH_CODES = ["unauthorized", "unauthenticated", "authentication_error", "invalid_api_key", "invalid_authorization", "forbidden", "permission_denied", "auth_error"];
/** The codes that mean capacity rather than a wall. */
const CAPACITY_CODES = ["rate_limit_error", "rate_limit_exceeded", "rate_limited", "resource_exhausted", "overloaded", "capacity", "service_unavailable", "too_many_requests"];

const EXPIRY_TEXT = /api[ _-]?key (?:has )?expired|\bexpired (?:api[ _-]?key|credential|token|key)\b|\bkey has expired\b/i;
const AUTH_TEXT = /invalid (?:api[ _-]?key|authorization(?: header)?|credential|token)|\bunauthori[sz]ed\b|\bauthentication failed\b|\bbad credentials\b/i;
const ENTITLEMENT_TEXT = /\bsubscription\b[^.]{0,60}\b(?:inactive|not active|expired|disabled|cancell?ed)\b|\bnot entitled\b|\bentitlement\b|\bno active (?:go |paid )?plan\b/i;
const CAPACITY_TEXT = /\boverloaded\b|\bcapacity\b|\btoo many requests\b|\brate[ _-]?limit|\btemporarily unavailable\b|\bservice unavailable\b/i;
/** An endpoint that reports itself down, which the pool words as a wall (`endpoint-unavailable-429`) at one status only. */
const ENDPOINT_DOWN_TEXT = /endpoint is unavailable|upstream request failed/i;

/** The first 4xx or 5xx in the text, which is how Pi writes a provider's status into `errorMessage`. */
function readStatus(message: string): number | undefined {
	const found = /\b(4\d\d|5\d\d)\b/.exec(message);
	return found?.[1] === undefined ? undefined : Number(found[1]);
}

/** Every `code` or `type` the body carries, plus the bare codes providers write without JSON. */
function readCodes(message: string): string[] {
	const codes: string[] = [];
	for (const match of message.matchAll(/"(?:code|type)"\s*:\s*"([A-Za-z0-9_.-]+)"/g)) {
		if (match[1] !== undefined) codes.push(match[1]);
	}
	for (const bare of ["UNAUTHORIZED", "UNAUTHENTICATED", "FORBIDDEN", "AUTHENTICATION_ERROR", "INVALID_API_KEY", "RESOURCE_EXHAUSTED", "OVERLOADED"]) {
		if (new RegExp(`\\b${bare}\\b`).test(message)) codes.push(bare);
	}
	return codes;
}

/**
 * What one failed request means for the ref that answered it: a wall, a failover with no wall,
 * or nothing this module can read. A pool shape is read first and is always a wall; then an
 * expired credential, then the status and code, then the entitlement wording, then capacity.
 */
export function classifyFailure(
	message: { stopReason?: string; errorMessage?: string },
	shapes: readonly QuotaShape[],
	now: number,
	/**
	 * What a matched shape means, when the caller knows: shape id to kind. Absent, and for an id this map does not
	 * carry, a shape is a usage limit, which is what `quotaShapes` is for. The pool's ids are data here so that this
	 * module names no provider, exactly as it names none of the wording.
	 */
	shapeKinds: Readonly<Record<string, FailureKind>> = {},
): FailureClassification {
	const none: FailureClassification = { wall: false, failover: false, kind: "none" };
	if (message.stopReason !== "error" || !message.errorMessage) return none;
	const text = message.errorMessage;
	const quota = classifyQuota(message, shapes, now);
	if (quota.quota) {
		return {
			wall: true,
			failover: true,
			kind: shapeKinds[quota.shapeId] ?? "usage",
			id: quota.shapeId,
			source: "shape",
			...(quota.resetAt !== undefined ? { resetAt: quota.resetAt } : {}),
			...(quota.assumed === true ? { assumed: true } : {}),
		};
	}
	const status = readStatus(text);
	const codes = readCodes(text).map((code) => code.toLowerCase());
	const code = codes[0];
	if (EXPIRY_TEXT.test(text)) return { wall: true, failover: true, kind: "expiry", id: "expired-credential", source: "expiry", ...(status !== undefined ? { status } : {}), ...(code !== undefined ? { code } : {}) };
	const authCode = codes.find((entry) => AUTH_CODES.includes(entry));
	if (authCode !== undefined) return { wall: true, failover: true, kind: "auth", id: "auth-code", source: "code", code: authCode, ...(status !== undefined ? { status } : {}) };
	if (status !== undefined && AUTH_STATUSES.includes(status)) return { wall: true, failover: true, kind: "auth", id: `http-${status}`, source: "status", status };
	if (AUTH_TEXT.test(text)) return { wall: true, failover: true, kind: "auth", id: "auth-wording", source: "wording", ...(status !== undefined ? { status } : {}) };
	if (ENTITLEMENT_TEXT.test(text)) return { wall: true, failover: true, kind: "entitlement", id: "inactive-subscription", source: "wording", ...(status !== undefined ? { status } : {}) };
	if (ENDPOINT_DOWN_TEXT.test(text)) return { wall: true, failover: true, kind: "unavailable", id: "endpoint-unavailable", source: "wording", ...(status !== undefined ? { status } : {}) };
	const capacityCode = codes.find((entry) => CAPACITY_CODES.includes(entry));
	if (capacityCode !== undefined || (status !== undefined && CAPACITY_STATUSES.includes(status)) || CAPACITY_TEXT.test(text)) {
		return {
			wall: false,
			failover: true,
			kind: "capacity",
			id: status !== undefined && CAPACITY_STATUSES.includes(status) ? `capacity-${status}` : "capacity-wording",
			source: status !== undefined && CAPACITY_STATUSES.includes(status) ? "status" : "wording",
			...(status !== undefined ? { status } : {}),
			...(capacityCode !== undefined ? { code: capacityCode } : {}),
		};
	}
	return none;
}
