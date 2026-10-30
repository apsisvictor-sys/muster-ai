/**
 * The contract table (OL12-D8, blueprint RD1/§5): every contract the doctor checks, with the
 * four fields it cannot derive — the owner, what the contract protects, the one bounded repair
 * and how to stop it safely.
 *
 * This table moved here with muster (OL12 item 1, D8): the rows name muster's own services and
 * units, so the table belongs to muster's package, and Pi's doctor imports it back through the
 * one tracked `harness/` link (RD1's direction: Pi's profile may import the harness, never the
 * reverse). The doctor's own rules — what is red, how old a proof may be — stay in
 * `health/doctor.ts`; this file is the registry the rules read.
 *
 * A row whose id has no entry here is red: a service that nobody registered has no owner and no
 * repair, so it cannot be trusted (spec §4, OL0). The timer entries are the units installed on
 * this machine; installing a new timer is registering its contract.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/**
 * One desk (spec §2 A7: the research desk, the decision desk, the usage and billing
 * watcher) and how long a gap its own cadence allows: cadence plus slack, where a desk
 * with no schedule gets room for the event that opens its next card.
 */
export const DESK_CONTRACTS: ReadonlyArray<{ id: string; freshMs: number }> = [
	// research-desk-morning.timer: daily 08:40 Europe/Sofia, plus two hours of slack.
	{ id: "research desk", freshMs: DAY_MS + 2 * HOUR_MS },
	// No schedule: a card opens when a decision has to be put to the operator.
	{ id: "decision desk", freshMs: 7 * DAY_MS },
	// pi-usage-snapshot.timer every 15 minutes, with slack for a rate-limited probe.
	{ id: "usage and billing watcher", freshMs: 6 * HOUR_MS },
];

export const SERVICE_IDS = { ledger: "muster ledger", gateway: "muster gateway", tick: "muster tick" } as const;

/** C: must keep this much free, in the GB Windows and the page show: under it the contract is red (spec §6). */
export const C_FREE_FLOOR_GB = 50;

/**
 * The `derived` contracts (spec §4): the conditions the doctor computes itself rather than reading from a
 * service's own record. Their ids are the table keys and the ids their rows carry.
 */
export const DERIVED_CONTRACTS = {
	/** C:'s free space against the floor (spec §6). */
	diskC: "disk-c",
	/** The oldest question nobody has prepared with its options (spec §7a: 30 minutes). */
	asksPreparation: "asks-preparation",
	/** No launch passed the resource gate for two hours while items were dispatchable (spec §7a, OL3). */
	machineCapacity: "machine-capacity",
	/** The weekly review's cursor: the subsystem audited last (spec §10 OL11). */
	auditRotation: "audit-rotation",
	/** The doctor's own extension probes, which run behind a two-hour due gate (spec §4). */
	doctorResult: "doctor-result",
	/** Every work item's stored state against its evidence (statederived-0005, the operator 2026-10-29). */
	workItemDrift: "work-item-drift",
} as const;

/** The contract's id, as the table and the page name it. */
export const C_CONTRACT_ID = DERIVED_CONTRACTS.diskC;

/**
 * What happens when a contract is red (spec §4, field `onRed`), as the one owner of the answer:
 * a bounded command the tick runs once per contract a day, an ask only the operator can answer, or a line
 * on the Services panel that never becomes a question.
 */
export type ContractOnRed =
	| { action: "repair"; command: string }
	| { action: "ask" }
	| { action: "panel" };

/**
 * One contract's declared fields (spec §4): the four the doctor cannot derive, plus the ask code its red
 * state raises under. They live here, in one table keyed by contract id, so a service cannot be checked
 * without an owner, a declared repair and a way to stop it.
 */
export interface ContractDeclaration {
	/** The agent or module that answers for the service. */
	owner: string;
	/** One line, in the operator's words, of what the contract protects. */
	purpose: string;
	/** What is done about its red state (spec §4): one bounded command, an ask, or a panel line only. */
	onRed: ContractOnRed;
	/** The ask code its red state is raised and withdrawn under; valid under `asks.ts` `CODE_PATTERN`. */
	askCode: string;
	/** How to stop it safely, and how to roll it back. */
	kill: string;
	/**
	 * Whether the tick may run this contract's `onRed` repair by itself (spec §4, OL3b). Absent means it may:
	 * the declared restart, once a day. `false` means the tick must not: the red state raises the prepared ask
	 * that names the one command, and nothing is run (Henry relay 2026-10-28 21:12 (f)). Restarting the core
	 * units is then the orchestrator's or the operator's action, never a loop's.
	 */
	autoRestart?: boolean;
}

/**
 * The owner the four timers of the REDTIMERS class route their ask to (Henry, relayed 2026-10-28 17:47): a red
 * timer of this class is the orchestrator's task, not one of the operator's decisions. `owner` is the contract's one
 * routing field — `contract-asks.ts` `raise` copies it onto the ask — so the class is expressed by setting it,
 * not by a second field.
 */
export const ORCHESTRATOR_OWNER = "the orchestrator";

/** The bounded repair, or nothing when this contract's red state is not a repair. */
export function onRedRepair(declaration: ContractDeclaration): string | undefined {
	return declaration.onRed.action === "repair" ? declaration.onRed.command : undefined;
}

/**
 * Every contract's declared fields, keyed by the id its row carries. A row whose id has no entry here is red:
 * a service that nobody registered has no owner and no repair, so it cannot be trusted (spec §4, OL0).
 * The timer entries are the units installed on this machine; installing a new timer is registering its contract.
 */
export const CONTRACT_TABLE: Readonly<Record<string, ContractDeclaration>> = {
	// ── Timers: each one's own cadence supplies its fresh window, and the restart is the repair ──
	"muster-tick.timer": {
		owner: "the tick (packages/muster/tick.ts)",
		purpose: "Runs the loop every two minutes: lanes, asks, events and the dispatcher.",
		onRed: { action: "repair", command: "systemctl --user restart muster-tick.timer" },
		askCode: "C-TICK-TIMER",
		kill: "stop and disable muster-tick.timer; rollback: systemctl --user enable --now muster-tick.timer",
	},
	"grokbot-oom-protect-report.timer": {
		owner: "the OOM report (scripts/oom-report.sh)",
		purpose: "Shows the protected units' oom_score_adj every minute, so a kill lands on the right process.",
		onRed: { action: "repair", command: "systemctl --user restart grokbot-oom-protect-report.timer" },
		askCode: "C-OOM-REPORT",
		kill: "stop and disable grokbot-oom-protect-report.timer; rollback: enable --now the same unit",
	},
	"pi-doctor.timer": {
		owner: "the doctor (health/doctor.ts)",
		purpose: "Runs every contract here, this one included, every five minutes.",
		onRed: { action: "repair", command: "systemctl --user restart pi-doctor.timer" },
		askCode: "C-DOCTOR",
		kill: "stop and disable pi-doctor.timer; rollback: systemctl --user enable --now pi-doctor.timer",
	},
	"pi-meter-browser.timer": {
		owner: "the meter browser (scripts/pi-meter-browser)",
		purpose: "Reads each plan's windows from the provider's own page every hour at :05.",
		onRed: { action: "repair", command: "systemctl --user restart pi-meter-browser.timer" },
		askCode: "C-METER-BROWSER",
		kill: "stop and disable pi-meter-browser.timer; the last reading stays in the usage snapshot",
	},
	"seat-nudge.timer": {
		owner: "seat-nudge (scripts/seat-nudge.sh)",
		purpose: "Nudges an idle seat every five minutes so a waiting lane is not forgotten.",
		onRed: { action: "repair", command: "systemctl --user restart seat-nudge.timer" },
		askCode: "C-SEAT-NUDGE",
		kill: "stop and disable seat-nudge.timer; rollback: enable --now the same unit",
	},
	"portal-deep-health-alert.timer": {
		owner: "portal deep health (/home/operator/.local/bin/portal-deep-health-alert)",
		purpose: "Alerts when portal-mcp's deep health check fails, every ten minutes.",
		onRed: { action: "repair", command: "systemctl --user restart portal-deep-health-alert.timer" },
		askCode: "C-PORTAL-HEALTH",
		kill: "stop and disable portal-deep-health-alert.timer; the alert path stays silent until it is re-enabled",
	},
	"muster-mailbox-auth.timer": {
		owner: "the mailbox auth check (packages/muster/lib/agent-inbox.ts)",
		purpose: "Checks the muster mailbox credentials every fifteen minutes.",
		onRed: { action: "repair", command: "systemctl --user restart muster-mailbox-auth.timer" },
		askCode: "C-MAILBOX-AUTH",
		kill: "stop and disable muster-mailbox-auth.timer; rollback: enable --now the same unit",
	},
	"portal-alerts-collect.timer": {
		owner: "the portal.example alert collector",
		purpose: "Collects portal.example alerts hourly at :12.",
		onRed: { action: "repair", command: "systemctl --user restart portal-alerts-collect.timer" },
		askCode: "C-PORTAL-ALERTS",
		kill: "stop and disable portal-alerts-collect.timer; collected alerts stay in its own store",
	},
	"pi-usage-snapshot.timer": {
		owner: "the usage snapshot (packages/muster/bin/usage-snapshot.mts)",
		purpose: "Writes every plan's windows, resets and balances every fifteen minutes.",
		onRed: { action: "repair", command: "systemctl --user restart pi-usage-snapshot.timer" },
		askCode: "C-USAGE-SNAPSHOT",
		kill: "stop and disable pi-usage-snapshot.timer; the page keeps the last snapshot and marks it stale",
	},
	"muster-asks-scan-hourly.timer": {
		owner: ORCHESTRATOR_OWNER,
		purpose: "Scans the transcripts for new asks every hour at :20.",
		onRed: { action: "repair", command: "systemctl --user restart muster-asks-scan-hourly.timer" },
		askCode: "C-ASKS-SCAN-HOURLY",
		kill: "stop and disable muster-asks-scan-hourly.timer; the asks file stays the record",
	},
	"mcp-health.timer": {
		owner: "the MCP probe (/home/operator/.local/bin/mcp-health)",
		purpose: "Probes every MCP server every thirty minutes.",
		onRed: { action: "repair", command: "systemctl --user restart mcp-health.timer" },
		askCode: "C-MCP-HEALTH",
		kill: "stop and disable mcp-health.timer; rollback: enable --now the same unit",
	},
	"pi-account-health.timer": {
		owner: "the account health check (scripts/account-health)",
		purpose: "Checks each provider account every thirty minutes, so a dead login is seen before a lane is.",
		onRed: { action: "repair", command: "systemctl --user restart pi-account-health.timer" },
		askCode: "C-ACCOUNT-HEALTH",
		kill: "stop and disable pi-account-health.timer; rollback: enable --now the same unit",
	},
	"be-vercel-error-sweep.timer": {
		owner: "the error sweeps (scripts/vercel-error-sweep.sh, scripts/sentry-error-sweep.sh)",
		purpose: "Sweeps the CRM app' Vercel and Sentry errors every hour.",
		onRed: { action: "repair", command: "systemctl --user restart be-vercel-error-sweep.timer" },
		askCode: "C-BE-ERROR-SWEEP",
		kill: "stop and disable be-vercel-error-sweep.timer; the sweeps write no product data",
	},
	"muster-asks-diff.timer": {
		owner: "the asks file diff (packages/muster/asks.ts)",
		purpose: "Diffs the asks files every hour, so a change made outside the ledger is seen.",
		onRed: { action: "repair", command: "systemctl --user restart muster-asks-diff.timer" },
		askCode: "C-ASKS-DIFF",
		kill: "stop and disable muster-asks-diff.timer; rollback: enable --now the same unit",
	},
	"opencode-free-probe.timer": {
		owner: "the free-model probe (scripts/opencode-free-probe.sh)",
		purpose: "Probes the free OpenCode GLM endpoint every hour, so a wall is known before a lane hits it.",
		onRed: { action: "repair", command: "systemctl --user restart opencode-free-probe.timer" },
		askCode: "C-OPENCODE-PROBE",
		kill: "stop and disable opencode-free-probe.timer; the router then keeps its last reading",
	},
	"webapp-backup.timer": {
		owner: "the Webapp Aesthetic Center backup job",
		purpose: "Backs up the Webapp database every night.",
		// The repair restarts the timer only: the backup store is never pruned by it.
		onRed: { action: "repair", command: "systemctl --user restart webapp-backup.timer" },
		askCode: "C-WEBAPP-BACKUP",
		kill: "stop and disable webapp-backup.timer; existing backups stay untouched",
	},
	"telemetry-ingest.timer": {
		owner: "the telemetry ingest (extensions/telemetry)",
		purpose: "Tops up the telemetry ledger with Claude Code and Hermes usage every night.",
		onRed: { action: "repair", command: "systemctl --user restart telemetry-ingest.timer" },
		askCode: "C-TELEMETRY",
		kill: "stop and disable telemetry-ingest.timer; the ledger keeps what it already holds",
	},
	"crm-app-acceptance-nightly.timer": {
		owner: "the CRM app' nightly acceptance (be-nightly scripts/lanes/nightly-acceptance.sh)",
		purpose: "Runs BE's nightly acceptance gate and reports its result.",
		onRed: { action: "repair", command: "systemctl --user restart crm-app-acceptance-nightly.timer" },
		askCode: "C-BE-NIGHTLY",
		kill: "stop and disable the unit; the gate can be run by hand for one night",
	},
	"muster-janitor.timer": {
		owner: "the janitor (packages/muster/bin/muster-janitor.mts)",
		purpose: "Runs the cleanup and the one declared repair per red contract, daily at 05:30.",
		onRed: { action: "repair", command: "systemctl --user restart muster-janitor.timer" },
		askCode: "C-JANITOR",
		kill: "stop and disable muster-janitor.timer; every archive and ref it made stays",
	},
	"muster-asks-scan.timer": {
		owner: ORCHESTRATOR_OWNER,
		purpose: "Scans the transcripts for new asks daily at 06:00.",
		onRed: { action: "repair", command: "systemctl --user restart muster-asks-scan.timer" },
		askCode: "C-ASKS-SCAN",
		kill: "stop and disable muster-asks-scan.timer; the asks file stays the record",
	},
	"web-release-check@web-app.timer": {
		owner: "the web release check (scripts/release-check)",
		purpose: "Checks Webapp Center's live site after a release.",
		onRed: { action: "repair", command: "systemctl --user restart 'web-release-check@web-app.timer'" },
		askCode: "C-RELEASE-WEBAPP",
		kill: "stop and disable the instance; the next release re-enables it",
	},
	"pi-receipts.timer": {
		owner: ORCHESTRATOR_OWNER,
		purpose: "Reads the providers' receipts daily at 07:40, so a charge is explained the same day.",
		onRed: { action: "repair", command: "systemctl --user restart pi-receipts.timer" },
		askCode: "C-RECEIPTS",
		kill: "stop and disable pi-receipts.timer; read receipts stay on disk",
	},
	"research-desk-morning.timer": {
		owner: "the research desk (packages/muster/research-desk.ts)",
		purpose: "Opens the research desk's morning card at 08:40 Europe/Sofia.",
		onRed: { action: "repair", command: "systemctl --user restart research-desk-morning.timer" },
		askCode: "C-RESEARCH-DESK",
		kill: "stop and disable research-desk-morning.timer; its cards stay in the store",
	},
	"agent-usage-digest.timer": {
		owner: "the usage digest (/home/operator/.local/bin/agent-usage-digest)",
		purpose: "Writes the daily usage digest and the savings line the page shows.",
		onRed: { action: "repair", command: "systemctl --user restart agent-usage-digest.timer" },
		askCode: "C-USAGE-DIGEST",
		kill: "stop and disable agent-usage-digest.timer; the last digest stays beside the snapshot",
	},
	"muster-mailbox-unread.timer": {
		owner: ORCHESTRATOR_OWNER,
		purpose: "Warns about unread mailbox messages daily at 09:05.",
		onRed: { action: "repair", command: "systemctl --user restart muster-mailbox-unread.timer" },
		askCode: "C-MAILBOX-UNREAD",
		kill: "stop and disable muster-mailbox-unread.timer; the inbox is the record",
	},
	"pi-wiki-curate.timer": {
		owner: "the wiki curation (scripts/wiki-curate)",
		purpose: "Curates ~/knowledge/wiki daily.",
		onRed: { action: "repair", command: "systemctl --user restart pi-wiki-curate.timer" },
		askCode: "C-WIKI-CURATE",
		kill: "stop and disable pi-wiki-curate.timer; the wiki is untouched by stopping it",
	},
	"pi-janitor.timer": {
		owner: "the Pi janitor (health/janitor.ts)",
		purpose: "Archives and prunes the Pi stores daily, on the due gate in janitor-state.json.",
		onRed: { action: "repair", command: "systemctl --user restart pi-janitor.timer" },
		askCode: "C-PI-JANITOR",
		kill: "stop and disable pi-janitor.timer; archives it made stay",
	},
	"launchpadlib-cache-clean.timer": {
		owner: "snapd's Launchpad cache cleaner",
		purpose: "Clears old Launchpad cache files.",
		// A snap-supplied unit, repaired by snapd's next refresh: nothing here may touch it.
		onRed: { action: "panel" },
		askCode: "C-LAUNCHPAD-CACHE",
		kill: "mask the unit if its finds ever cost more than the cache it clears",
	},
	"harness-review.timer": {
		owner: "the harness review (claude-mods/harness-review)",
		purpose: "Reviews the Claude Code harness mods twice a week, Monday and Thursday.",
		onRed: { action: "repair", command: "systemctl --user restart harness-review.timer" },
		askCode: "C-HARNESS-REVIEW",
		kill: "stop and disable harness-review.timer; its proposals stay in the plans folder",
	},
	"hermes-update.timer": {
		owner: "Hermes' self-update (/home/operator/.local/bin/hermes-auto-update.sh)",
		purpose: "Updates Hermes weekly.",
		onRed: { action: "repair", command: "systemctl --user restart hermes-update.timer" },
		askCode: "C-HERMES-UPDATE",
		kill: "stop and disable hermes-update.timer; update Hermes by hand from then on",
	},
	"radar-db-pull.timer": {
		owner: "the Market Radar copy (/home/operator/.local/bin/radar-db-pull.sh)",
		purpose: "Copies the Market Radar database weekly, Sunday 13:00, catching up after the PC was off.",
		onRed: { action: "repair", command: "systemctl --user restart radar-db-pull.timer" },
		askCode: "C-RADAR-PULL",
		kill: "stop and disable radar-db-pull.timer; the copy on disk stays",
	},
	"learning-digest.timer": {
		owner: "the learning digest",
		purpose: "Writes the weekly learning digest, Sundays 20:00 Europe/Sofia.",
		onRed: { action: "repair", command: "systemctl --user restart learning-digest.timer" },
		askCode: "C-LEARNING-DIGEST",
		kill: "stop and disable learning-digest.timer; read digests stay on disk",
	},
	"compaction-probe.timer": {
		owner: "the compaction probe",
		purpose: "Probes a compaction resume weekly, Sundays 20:30 Europe/Sofia.",
		onRed: { action: "repair", command: "systemctl --user restart compaction-probe.timer" },
		askCode: "C-COMPACTION-PROBE",
		kill: "stop and disable compaction-probe.timer; its logs stay",
	},
	"memory-drain.timer": {
		owner: "the memory drain (pi-mono run-custom.sh)",
		purpose: "Drains the memory extraction queue every thirty minutes, for the Claude sessions that feed it.",
		onRed: { action: "repair", command: "systemctl --user restart memory-drain.timer" },
		askCode: "C-MEMORY-DRAIN",
		kill: "stop and disable memory-drain.timer; the queue keeps every entry until it is drained",
	},
	"snap.firmware-updater.firmware-notifier.timer": {
		owner: "snapd's firmware notifier",
		purpose: "Tells Ubuntu when a firmware update is available.",
		// A snap-supplied unit, repaired by snapd's next refresh: nothing here may touch it.
		onRed: { action: "panel" },
		askCode: "C-FIRMWARE-NOTIFY",
		kill: "mask the unit; firmware updates are then checked from the Ubuntu settings by hand",
	},
	// ── The services with no timer of their own ──
	[SERVICE_IDS.ledger]: {
		owner: "the ledger (packages/muster/ledger)",
		purpose: "Holds the one durable record: lanes, asks, goals and events.",
		onRed: { action: "repair", command: "systemctl --user restart musterd.service" },
		// The record every lane and the gateway are writing to: a red ledger is alerted, never restarted here.
		autoRestart: false,
		askCode: "C-LEDGER",
		kill: "stop the daemon; the sqlite file stays and a restart resumes from it",
	},
	[SERVICE_IDS.gateway]: {
		owner: "the gateway (packages/muster/gateway)",
		purpose: "Serves the command center page and the tailnet tools.",
		onRed: { action: "repair", command: "systemctl --user restart muster-gateway.service" },
		// The page the operator and the orchestrator read: a red gateway is alerted, never restarted here.
		autoRestart: false,
		askCode: "C-GATEWAY",
		kill: "stop the gateway; rollback: start it, its state dir and the ledger are untouched",
	},
	[SERVICE_IDS.tick]: {
		owner: "the tick (packages/muster/tick.ts)",
		purpose: "Marks each pass, so a loop that stopped is visible.",
		onRed: { action: "repair", command: "systemctl --user restart muster-tick.timer" },
		askCode: "C-TICK",
		kill: "stop and disable muster-tick.timer; rollback: systemctl --user enable --now muster-tick.timer",
	},
	// ── The desks ──
	"research desk": {
		owner: "the research desk (packages/muster/research-desk.ts)",
		purpose: "Puts the day's ideas in front of the operator each morning.",
		onRed: { action: "repair", command: "systemctl --user restart research-desk-morning.timer" },
		askCode: "C-DESK-RESEARCH",
		kill: "stop and disable research-desk-morning.timer; its cards stay in the store",
	},
	"decision desk": {
		owner: "the decision desk (packages/muster/research-desk.ts)",
		purpose: "Puts a decision to the operator when one has to be made.",
		// A card opens on an event, not a clock: its red state is an ask, because only a decision clears it.
		onRed: { action: "ask" },
		askCode: "C-DESK-DECISION",
		kill: "stop writing cards; the ledger keeps the ones already made",
	},
	"usage and billing watcher": {
		owner: "the usage snapshot (packages/muster/bin/usage-snapshot.mts)",
		purpose: "Keeps each plan's windows, resets and balances as last read.",
		onRed: { action: "repair", command: "systemctl --user restart pi-usage-snapshot.timer" },
		askCode: "C-DESK-USAGE",
		kill: "stop and disable pi-usage-snapshot.timer; the last snapshot stays on disk",
	},
	// ── The machine, as the doctor's own computed conditions (spec §4, kind `derived`) ──
	[C_CONTRACT_ID]: {
		owner: "the doctor (health/doctor.ts); the janitor's fstrim is its only repair",
		purpose: `C: keeps at least ${C_FREE_FLOOR_GB} GB free, so Windows and WSL never fill the disk.`,
		// The janitor trims /mnt/c first; only the operator can free space there, so the red state is an ask.
		onRed: { action: "ask" },
		askCode: "C-DISK",
		kill: "none: this check writes nothing. Removing its row from this table turns it red by design",
	},
	[DERIVED_CONTRACTS.asksPreparation]: {
		owner: "the questions queue (packages/muster/asks.ts)",
		purpose: "A question for the operator is prepared with its options and recommendation within half an hour.",
		onRed: { action: "panel" },
		askCode: "C-ASK-PREP",
		kill: "none: it is computed from the queue's own events and stops when they are out of the way",
	},
	[DERIVED_CONTRACTS.machineCapacity]: {
		owner: "the resource gate (scripts/heavy-gate.sh) and the dispatcher (packages/muster/tick.ts)",
		purpose: "A dispatchable item starts within two hours, so a stalled machine shows on the panel.",
		onRed: { action: "panel" },
		askCode: "C-CAPACITY",
		kill: "none: it is computed from the gate's and the dispatcher's own records",
	},
	[DERIVED_CONTRACTS.auditRotation]: {
		owner: "the weekly review (spec OL11, state/muster/audit-rotation.json)",
		purpose: "The week's subsystem review runs, so every contract is audited in its turn.",
		onRed: { action: "panel" },
		askCode: "C-AUDIT",
		kill: "delete the cursor file; the contract then waits for its first run again",
	},
	[DERIVED_CONTRACTS.doctorResult]: {
		owner: "the doctor (health/doctor.ts)",
		purpose: "The doctor's own extension probes run, behind their two-hour due gate.",
		onRed: { action: "repair", command: "systemctl --user restart pi-doctor.timer" },
		askCode: "C-DOCTOR-RESULT",
		kill: "stop and disable pi-doctor.timer; the last result stays on disk and the panel shows it stale",
	},
	[DERIVED_CONTRACTS.workItemDrift]: {
		owner: "the work-item reconciler (packages/muster/work-item-state.ts)",
		purpose: "Every work item's stored state matches its evidence, so the board shows a claim as a claim and never as a fact.",
		onRed: { action: "panel" },
		askCode: "C-WORK-ITEM-DRIFT",
		kill: `delete state/muster/work-item-drift.json and stop the pass that writes it; the records are untouched and the contract waits for its first run again`,
	},
};

/** Every contract's ask code, the only codes the `tick` and `doctor` writers may use (spec §4, OL0b). */
export const CONTRACT_ASK_CODES: ReadonlySet<string> = new Set(Object.values(CONTRACT_TABLE).map((entry) => entry.askCode));

/** The file the tick writes its pass into and the doctor reads as the tick's proof (spec §4). */
export const TICK_HEARTBEAT_FILE = "tick-heartbeat.json";

