/**
 * `muster provider check` — the provider health sweep (brief `providerhealth-0935`).
 *
 * One cheap real call per provider the pool routes, one classification per answer, and one message to
 * Henry per newly seen wall (at most one an hour while it persists, one when it clears). The sweep, the
 * classification, the memory and the wording live in `health/provider-health.ts`; this file is the verb:
 * the pool file, the state directory and the bus are read here and passed in as ports.
 *
 * A wall is not a lane's problem yet: nothing is restarted, no provider is disabled, and no key is touched.
 * The message names the provider, the shape it matched, the provider's own redacted words and when it was
 * first seen, so whoever reads it can act on the provider rather than on a dying lane.
 *
 * Exit codes: 0 every provider answered healthy, 1 any provider answered with a wall or an unclassified
 * error (or a message could not be sent), 2 the usage is wrong or the pool did not load.
 */

import { musterStateDir } from "../binding.ts";
import { tellGrokbot } from "../grokbot-tell.ts";
import { PROVIDER_HEALTH_SENDER, liveProviderHealthPorts, providerHealthPass, type ProviderHealthResult } from "../health/provider-health.ts";
import { parseFlags, type CliCommand } from "./types.ts";

const USAGE = [
	"muster provider check [--json] [--dry-run]",
	"  makes one cheap test call per provider that provider-pool.json routes and classifies the answer:",
	"  healthy, a rejected or expired credential, an inactive subscription, a usage limit, or other",
	"  tells Henry once per newly seen wall, at most once an hour while it persists, and once when it clears",
	"  exit 0 every provider healthy, 1 a wall or an unclassified error, 2 the usage is wrong",
].join("\n");

/** One line per provider: the reading, and what was done about it. */
function line(result: ProviderHealthResult, dryRun: boolean): string {
	if (result.class === "walled") {
		const head = result.ref === "" ? `${result.provider}: not called` : `${result.provider} ${result.ref}: not called`;
		return `${head} — ${result.note ?? "the pool records a wall"}`;
	}
	const source = result.shapeId !== undefined ? `shape "${result.shapeId}"` : result.marker !== undefined ? `marker "${result.marker}"` : "no shape";
	const words = result.text === null ? "" : ` — ${result.text}`;
	const would = dryRun ? "would tell Henry" : "told Henry";
	const action =
		result.action === "alert"
			? ` -> ${would}`
			: result.action === "repeat"
				? ` -> ${would} again (still not cleared)`
				: result.action === "cleared"
					? ` -> ${would} it cleared`
					: result.action === "alert-failed"
						? ` -> Henry was NOT told: ${result.failure ?? "the send failed"}`
						: "";
	const reset = result.resetAt === undefined ? "" : `, resets ${new Date(result.resetAt).toISOString()}`;
	return `${result.provider} ${result.ref}: ${result.class} (${source}${reset}) ${result.latencyMs}ms${words}${action}`;
}

export const command: CliCommand = {
	name: "provider",
	summary: "Sweep every provider the pool routes with one cheap test call and tell Henry about a wall",
	usage: USAGE,
	async run(ctx) {
		const parsed = parseFlags(ctx.argv, []);
		const [subcommand, ...rest] = parsed.positionals;
		if (subcommand !== "check" || rest.length > 0) {
			ctx.io.err(`muster provider: one subcommand is required\n${USAGE}`);
			return 2;
		}
		const dryRun = parsed.flags.has("dry-run");
		const stateDir = musterStateDir();
		let ports;
		try {
			ports = liveProviderHealthPorts({
				stateDir,
				tellHenry: (text, key) => tellGrokbot(stateDir, PROVIDER_HEALTH_SENDER, text, key),
				...(ctx.env["PI_PROVIDER_POOL_PATH"] !== undefined ? { poolPath: ctx.env["PI_PROVIDER_POOL_PATH"] } : {}),
			});
		} catch (error) {
			ctx.io.err(`muster provider: ${error instanceof Error ? error.message : String(error)}`);
			return 2;
		}
		const results = await providerHealthPass(ports, { dryRun });
		if (ctx.json) {
			ctx.io.out(JSON.stringify({ dryRun, results }, null, 2));
		} else {
			for (const result of results) ctx.io.out(line(result, dryRun));
			const walls = results.filter((result) => result.class !== "healthy").length;
			ctx.io.out(`${results.length} provider(s) checked, ${walls} not healthy${dryRun ? " (dry run: Henry was not told, no memory written)" : ""}`);
		}
		const unattempted = results.some((result) => result.action === "alert-failed");
		return results.some((result) => result.class !== "healthy") || unattempted ? 1 : 0;
	},
};
