/**
 * `muster subscriptions [--check]` — the subscription and metered-account
 * inventory (UM4 of `plans/provider-accounts/usage-monitor-blueprint-2026-10-16.md`).
 *
 * The inventory is `extensions/telemetry-stats/subscriptions.json`, read
 * through its one loader (`loadSubscriptionPlans`), which also applies a
 * receipt a `price` signal carries (UM8) and owns the entry shape.
 *
 * `--check` compares the inventory with the evidence on disk: provider ids in
 * `~/.pi/agent/auth.json` (ids and credential types only), variable names in
 * `~/.config/agent-keys.env` (parsed, never sourced), the providers
 * `models.json` and `provider-pool.json` route to, and whether the commands an
 * entry names are on `PATH`. It prints what is unlisted or stale, and never a
 * key, a token or a value.
 *
 * The verb is auto-registered: `scripts/muster.mts` discovers every module
 * under `extensions/muster/cli/` that exports `command`, so this file is the
 * only change that lands `muster subscriptions`.
 */

import { checkSubscriptionInventory, formatInventory, formatInventoryCheck, loadSubscriptionPlans } from "../../routing/subscriptions.ts";
import { parseFlags, type CliCommand } from "./types.ts";

const USAGE = [
	"muster subscriptions [--check] [--json]",
	"  lists every subscription, metered account and free-model set in the inventory",
	"  --check compares it with auth.json, ~/.config/agent-keys.env, models.json,",
	"          provider-pool.json and PATH, and prints what is unlisted or stale",
	"  --json is the machine view of either listing",
].join("\n");

export const command: CliCommand = {
	name: "subscriptions",
	summary: "List the subscription inventory; --check compares it with the evidence on disk",
	usage: USAGE,
	async run(ctx) {
		const parsed = parseFlags(ctx.argv, []);
		try {
			if (parsed.flags.has("check")) {
				const check = checkSubscriptionInventory({ env: ctx.env });
				ctx.io.out(ctx.json ? JSON.stringify(check, null, 2) : formatInventoryCheck(check).join("\n"));
				return 0;
			}
			const plans = loadSubscriptionPlans();
			ctx.io.out(ctx.json ? JSON.stringify({ plans }, null, 2) : formatInventory(plans).join("\n"));
			return 0;
		} catch (error) {
			ctx.io.err(`muster subscriptions: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
			return 1;
		}
	},
};
