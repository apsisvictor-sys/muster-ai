/**
 * The `muster` CLI contract — A3 of the harness bus design, section 4.7.
 *
 * Each command is one module under this directory exporting `command`. The
 * frame (scripts/muster.mts) discovers them by directory scan, so a new
 * command (pi-history's `muster lanes`) is one added file, never an edit to a
 * shared registry.
 */

import { reservedSenderRefusal } from "../gateway/state.ts";
import { resolveBusIdentity, seatContextFor } from "../seats.ts";

export type CliIO = {
	out: (line: string) => void;
	err: (line: string) => void;
};

export type CliContext = {
	/** Arguments after the command name (flags and positionals, unparsed). */
	argv: string[];
	/** Repository root for Concord resolution: --repo, CONCORD_REPO_ROOT, else cwd. */
	repoRoot: string;
	/** The caller's Concord identity as the frame resolved it: --agent, else CONCORD_AGENT_ID. */
	agentId: string | undefined;
	/**
	 * The identity this session proves it has (its own lane id). A name on the command
	 * line is a claim and never replaces it (REPREF): a brief's quoted command string
	 * cannot change which lane a lane is.
	 */
	sessionAgentId?: string;
	/** True when --json was passed to the frame. */
	json: boolean;
	cwd: string;
	env: NodeJS.ProcessEnv;
	io: CliIO;
	readStdin: () => Promise<string>;
};

export type CliCommand = {
	name: string;
	summary: string;
	usage: string;
	run: (ctx: CliContext) => Promise<number>;
};

export type ParsedFlags = {
	/** Value flags: `--key value` or `--key=value` (last value wins). */
	values: Map<string, string>;
	/** Every value per key, in order (repeatable flags like `--log`). */
	multi: Map<string, string[]>;
	/** Boolean flags (`--key`), including `--no-<key>` as `no-<key>` is not set: see `has`. */
	flags: Set<string>;
	positionals: string[];
};

/**
 * Parse `--key value`, `--key=value`, `--flag` and `-abc`. Unknown shapes are
 * positionals so a command can report its own usage rather than guess.
 */
export function parseFlags(argv: string[], valueFlags: readonly string[]): ParsedFlags {
	const values = new Map<string, string>();
	const multi = new Map<string, string[]>();
	const flags = new Set<string>();
	const positionals: string[] = [];
	const record = (key: string, value: string): void => {
		values.set(key, value);
		multi.set(key, [...(multi.get(key) ?? []), value]);
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (arg === "--") {
			positionals.push(...argv.slice(index + 1));
			break;
		}
		const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
		if (equals > 2) {
			const key = arg.slice(2, equals);
			if (valueFlags.includes(key)) {
				record(key, arg.slice(equals + 1));
				continue;
			}
		}
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			if (valueFlags.includes(key)) {
				const next = argv[index + 1];
				if (next === undefined) {
					record(key, "");
					continue;
				}
				record(key, next);
				index += 1;
				continue;
			}
			flags.add(key);
			continue;
		}
		positionals.push(arg);
	}
	return { values, multi, flags, positionals };
}

/**
 * The caller's identity the frame resolved, or a clear refusal. A seat name (`orchestrator`, `architect`,
 * `designer`) is an identity only for the seat's holder: it needs the seat's current credential (seats blueprint,
 * Privileges 1), and an unclaimed seat (epoch 0) still accepts the name.
 *
 * The identity is the one the session proves it has (`sessionAgentId`), not the one a
 * command line names (`agentId`). The seat owner decides the difference
 * (`resolveBusIdentity`): a name that names a seat the session does not hold is dropped
 * with a notice, so a lane's report is filed as the lane even when the command it copied
 * out of a brief named the orchestrator seat (REPREF).
 */
export function requireAgentId(ctx: CliContext): string | { error: string } {
	const identity = resolveBusIdentity(ctx.agentId, ctx.sessionAgentId, ctx.env, seatContextFor(ctx.env));
	if (!identity.ok) return { error: identity.error };
	const reserved = reservedSenderRefusal(identity.id);
	if (reserved !== undefined) return { error: reserved };
	if (identity.notice !== undefined) ctx.io.err(`muster: ${identity.notice}`);
	return identity.id;
}
