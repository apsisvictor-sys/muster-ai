/**
 * `core/decision-types.ts` — the decision vocabulary (S7).
 *
 * The typed kinds, concrete options, scope revision and open-request shape a
 * decision card is built from. Muster's decision store and the provider policy
 * both read them here, so routing carries no import into Muster.
 */

/** Typed decision kinds. The model cannot invent a new authority category. */
export type DecisionKind = "product-decision" | "authorization" | "credential" | "human-login" | "review";

export const DECISION_KINDS: readonly DecisionKind[] = [
	"product-decision",
	"authorization",
	"credential",
	"human-login",
	"review",
];

export type DecisionOption = {
	id: string;
	label: string;
	/** Optional per-option recommendation text; the decision-level recommendation stays authoritative. */
	recommendation?: string;
};

/** Scope/decision revision the answer was requested against (git ref, sprint id, revision number). */
export type ScopeRevision = string | number;

export type OpenDecisionInput = {
	kind: DecisionKind;
	question: string;
	options: DecisionOption[];
	/**
	 * Recommended option id, or short free-text advice. Option IDs remain the
	 * only values an answer may select.
	 */
	recommendation: string;
	blockedTaskIds: string[];
	scopeRevision: ScopeRevision;
	/**
	 * May the recommendation apply itself at the deadline? Default false: a card
	 * waits for a person unless it was explicitly opened as reversible.
	 */
	reversible?: boolean;
	/**
	 * Hours before the recommendation applies. Defaults to
	 * `DECISION_DEFAULT_AUTO_APPLY_HOURS` (2) for a reversible card, and is
	 * rejected for a non-product kind, which has no deadline at all.
	 */
	autoApplyHours?: number;
};
