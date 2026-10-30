/**
 * `muster probe <provider/model>` — UM9's one bounded model probe.
 *
 * One short request with one tool, through the same model registry Pi uses
 * (`scripts/model-probe.ts`), and one `probe` signal in the UM8 store:
 * `pass`, or `fail` with the error class from `classifyQuota` and the latency.
 *
 * The ref is refused before any request when it is not one a probe may call: a
 * metered provider is never probed, and a model the catalog does not show as
 * free needs a subscription snapshot row with headroom. The probe is the only
 * thing that starts a request; no timer and no gateway call starts one.
 *
 * Exit codes: 0 the model passed, 1 the model failed (or the store refused the
 * write), 2 the ref was refused or the usage is wrong. Nothing here prints a
 * key: the outcome's message is redacted by the probe itself.
 *
 * The verb is auto-registered: `scripts/muster.mts` discovers every module
 * under `extensions/muster/cli/` that exports `command`, so this file is the
 * only change that lands `muster probe`.
 */

import { catalogsPath, readCatalogState } from "../bin/model-catalog-scan.mts";
import { ProbeRefusal, runProbe } from "../bin/model-probe.mts";
import { usageSnapshotPath } from "../bin/usage-snapshot.mts";
import { musterStateDir } from "../binding.ts";
import { parseFlags, type CliCommand } from "./types.ts";

const USAGE = [
	"muster probe <provider/model> [--json]",
	"  one bounded request with one tool; writes one probe signal to <stateDir>/signals/events.jsonl",
	"  a metered provider is refused; otherwise the catalog must show the model free, or its subscription row needs headroom",
	"  exit 0 the model passed, 1 it failed, 2 the ref was refused; --json is the machine view",
].join("\n");

export const command: CliCommand = {
	name: "probe",
	summary: "Probe one model with one short tool-call request and write one probe signal",
	usage: USAGE,
	async run(ctx) {
		const parsed = parseFlags(ctx.argv, []);
		const ref = parsed.positionals[0]?.trim();
		if (ref === undefined || ref === "" || parsed.positionals.length > 1) {
			ctx.io.err(`muster probe: one <provider/model> ref is required\n${USAGE}`);
			return 2;
		}
		const stateDir = musterStateDir();
		const catalog = readCatalogState(catalogsPath(ctx.env));
		const free = new Set(Object.values(catalog.providers).flatMap((entry) => entry.free));
		try {
			const outcome = await runProbe(ref, {
				stateDir,
				snapshotPath: usageSnapshotPath(ctx.env),
				catalogSaysFree: (provider, modelId) => free.has(`${provider}/${modelId}`),
			});
			if (ctx.json) {
				ctx.io.out(JSON.stringify(outcome, null, 2));
				return outcome.verdict === "pass" ? 0 : 1;
			}
			const detail = outcome.verdict === "pass" ? `${outcome.latencyMs}ms via ${outcome.clientVersion}` : `${outcome.errorClass ?? "error"} ${outcome.latencyMs}ms via ${outcome.clientVersion}${outcome.message === null ? "" : ` — ${outcome.message}`}`;
			ctx.io.out(`probe ${outcome.ref}: ${outcome.verdict} (${detail}) -> ${outcome.signal.id}${outcome.signal.duplicate ? " (already in the log)" : ""}`);
			return outcome.verdict === "pass" ? 0 : 1;
		} catch (error) {
			if (error instanceof ProbeRefusal) {
				ctx.io.err(`muster probe: ${error.message}`);
				return 2;
			}
			ctx.io.err(`muster probe: ${error instanceof Error ? error.message : String(error)}`);
			return 1;
		}
	},
};
