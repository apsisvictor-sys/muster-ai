/**
 * The one owner of the toolbelt tool's description, actions and parameter schema.
 * The Pi tool (`pi_toolbelt`, extensions/toolbelt/index.ts) and the MCP server (toolbelt/mcp/server.ts)
 * both import this, so what a model is told about the tool cannot drift between surfaces.
 */
import { Type } from "typebox";

export const TOOLBELT_ACTIONS = ["find", "providers", "menu", "run", "status", "accounts", "ledger", "refresh_surface", "discover", "call", "refresh", "link", "unlink", "links", "audit_secrets", "catalog_check", "inventory", "generate_cli"] as const;

export type ToolbeltAction = (typeof TOOLBELT_ACTIONS)[number];
export type ToolbeltParams = {
	action: ToolbeltAction;
	service?: string;
	provider?: string;
	operation?: string;
	args?: Record<string, unknown>;
	project?: string;
	account?: string;
	dryRun?: boolean;
	confirmMutating?: boolean;
	reason?: string;
	name?: string;
	target?: string;
	kind?: string;
	limit?: number;
	specPath?: string;
	query?: string;
	group?: string;
	command?: string[];
	confirmDestructive?: boolean;
	cwd?: string;
	timeoutMs?: number;
	stdinFile?: string;
	allowUnlisted?: boolean;
	fast?: boolean;
	all?: boolean;
};

export const TOOLBELT_PARAMS_SCHEMA = Type.Object({
	action: Type.String({
		enum: TOOLBELT_ACTIONS,
		description: "run (execute a provider CLI command verbatim) | find (search every provider's commands by intent) | menu | providers | status | accounts | ledger | refresh_surface | legacy: discover, call, refresh, link, unlink, links, audit_secrets, catalog_check, inventory, generate_cli",
	}),
	service: Type.Optional(Type.String({ description: "External service/provider id, e.g. vercel, railway, github, stripe, google-workspace, youtube, sentry, tailscale, resend, pixellab, runware, pally." })),
	provider: Type.Optional(Type.String({ description: "Alias for service, for CLI compatibility." })),
	operation: Type.Optional(Type.String({ description: "Curated operation name for legacy action='call'. For a command the CLI documents, use action='run' with command instead." })),
	args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Non-secret operation arguments for legacy action='call'. Secret-shaped input is rejected by pi-toolbelt." })),
	project: Type.Optional(Type.String({ description: "Project selector or project slug. Uses a fail-closed provider account binding when configured." })),
	account: Type.Optional(Type.String({ description: "Non-secret Toolbelt account alias. The actual provider CLI owns this account's credentials/profile." })),
	dryRun: Type.Optional(Type.Boolean({ default: false, description: "Request a dry run when supported by the provider adapter." })),
	confirmMutating: Type.Optional(Type.Boolean({ default: false, description: "Legacy compatibility only. Some legacy action='call' adapters still answer approval_required unless this and a non-empty reason are present, so pass it when one asks. It grants nothing by itself — the approval is the conversation in chat — and action='run' never needs it." })),
	reason: Type.Optional(Type.String({ description: "Short audit-trail note; legacy action='call' adapters that require confirmMutating also require this to be non-empty. Not an approval." })),
	name: Type.Optional(Type.String({ description: "Non-secret link name for action='link'." })),
	target: Type.Optional(Type.String({ description: "Non-secret link target/path/url for action='link'." })),
	kind: Type.Optional(Type.String({ description: "Link kind for action='link'." })),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: 1000, description: "Max ledger entries." })),
	specPath: Type.Optional(Type.String({ description: "Manual APISpec path for generated CLI readiness/generation." })),
	query: Type.Optional(Type.String({ description: "For action='find': what you want to do, e.g. 'deployment logs', 'send an email'. Searches every provider." })),
	group: Type.Optional(Type.String({ description: "For action='menu': one command group of a large CLI, e.g. 'pr' for github." })),
	command: Type.Optional(Type.Array(Type.String(), { description: "For action='run': the provider CLI command and its flags as an array, e.g. ['logs','--limit','20']. Forwarded verbatim after Toolbelt's '--' separator. Never put a secret value here." })),
	confirmDestructive: Type.Optional(Type.Boolean({ default: false, description: "Deprecated: was Toolbelt's second gate for destructive commands. Recorded and forwarded for CLI compatibility; authorises nothing on its own." })),
	cwd: Type.Optional(Type.String({ description: "For action='run'/'call': absolute working directory for the provider CLI. Omit to inherit the session directory." })),
	timeoutMs: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Overall budget in milliseconds for the whole call. For action='run'/'call' it is also forwarded to the CLI as --timeout-ms and --deadline-ms (with wrapper grace) so the CLI reports its own timeout instead of being killed at the same moment; for any other action it bounds how long the wrapper waits. Omit to let the CLI's own per-command default govern." })),
	stdinFile: Type.Optional(Type.String({ description: "For action='run'/'call': absolute path to a local file whose contents are fed to the provider CLI's stdin. Contents never enter arguments, output or logs — only the path travels here." })),
	fast: Type.Optional(Type.Boolean({ default: false, description: "For action='status': read local/config state only and skip provider auth probes, for a quick offline answer. Forwarded as the CLI's --fast." })),
	all: Type.Optional(Type.Boolean({ default: false, description: "For action='providers': include registered providers whose CLI is not installed, i.e. the full registry instead of the installed subset. Forwarded as the CLI's --all." })),
	allowUnlisted: Type.Optional(Type.Boolean({ default: false, description: "Legacy compatibility only. The CLI no longer refuses unlisted commands — it runs them and reports a menu note — so this authorises nothing. Accepted and forwarded for CLI compatibility." })),
});

export const TOOLBELT_TOOL_DESCRIPTION = "AI-native shared CLI wrapper for external provider operations, backed by ~/.pi/agent/harness/toolbelt/bin/pi-toolbelt. It runs the provider's own CLI: whatever that CLI supports, action:'run' passes through. It never returns or stores secret values.\n\nRUN: when you already know the command, run it. {action:'run', service:'vercel', command:['logs','--limit','20']} — command is the provider CLI's own argv as an array, forwarded verbatim after Toolbelt's '--' separator. Do not ask twice for an action the operator already authorized in this conversation: rerunning it needs no approval flag, and no flag exists that grants approval. A new mutation is named in chat before the first run; the envelope's operationClass and hint tell you which commands that means.\n\nDISCOVERY: use action:'find' with query set to the intent ('deployment logs', 'send an email') when you do not know the command; it searches every provider CLI and returns matching commands with their flags and class. action:'menu' with service returns that CLI's whole menu, add group for one section of a large CLI. action:'providers' lists which CLIs exist here. A command that is missing from the index is a discovery problem, not a refusal: find it, then run it.\n\nEXECUTION CONTROLS: cwd (absolute working dir for the provider CLI, action 'run'/'call'), timeoutMs (positive ms budget for the whole call; 'run'/'call' also forward it as --timeout-ms/--deadline-ms with wrapper grace so the CLI reports its own timeout instead of being killed mid-flight, and every other action honours it as the wrapper's own wait), stdinFile (absolute local file path whose contents the CLI feeds to the provider CLI's stdin; the contents never enter arguments, output or logs), fast (action 'status': local/config-only answer, skipping provider auth probes), all (action 'providers': include registered CLIs that are not installed). allowUnlisted remains a legacy field: the CLI runs an unlisted command anyway and reports a menu note, so it grants nothing.\n\nACCOUNTS: pass account or project to select between multiple accounts for one provider. With several configured and no selection Toolbelt fails closed and lists them instead of guessing. A provider's own --project flag is different from the project parameter and belongs inside command.\n\nFAILURES: the result carries hint naming the concrete fix — the provider's own error, a missing positional argument, a wrong flag, a truncated payload, or the closest real command. Act on hint instead of guessing again. A hint that names a shell command is translated into the equivalent action for you.\n\nSAFEGUARDS THAT REMAIN: secret-shaped input is rejected before dispatch and provider output is redacted, so secret values never travel in command or appear in output. Account/project bindings fail closed rather than falling back to another account, and policy-classified operations may be refused by Toolbelt or the provider itself. None of that is an approval: it cannot be waived with confirmMutating.\n\nLEGACY: discover, inventory and call are legacy. call runs curated named operations and validates them against the provider catalogue — if the CLI documents the command but call does not know it, use action:'run'. Some legacy call adapters still answer approval_required unless confirmMutating and a non-empty reason are passed; that is a legacy adapter contract, not a second confirmation authority, and action:'run' never needs it. confirmDestructive is accepted and forwarded for CLI compatibility and authorises nothing.";
