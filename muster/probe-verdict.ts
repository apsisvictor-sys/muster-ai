/**
 * The probe verdict readers (UM11 of
 * `plans/provider-accounts/usage-monitor-blueprint-2026-10-16.md`).
 *
 * `muster pool admit` gates a free-model admission on a `pass` probe signal from
 * the last 24 hours, and the gateway's `signals_add` gates its free-launch ask
 * on the same reading. Both callers are Muster code, so the reader lives here,
 * beside the store whose log it reads (`signals.ts` owns the append, the dedupe
 * and the read): a Muster module never imports `scripts/*`, and
 * `scripts/model-probe.ts` — the probe that writes those signals — imports this
 * file instead of the other way round.
 *
 * This is the pure reader only: it never probes, never writes and never spends.
 * A missing, old or failed probe reads as "not passed"; absent evidence is not
 * evidence.
 */

import { normalizeProviderId } from "../routing/provider-policy.ts";
import { SIGNAL_READ_LIMIT_MAX, readSignals } from "./signals.ts";

/** A `pass` probe is evidence for this long (UM11 admits on a pass from the last 24 hours). */
export const PROBE_PASS_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The verdict a `probe` signal's text carries. */
export type ProbeVerdict = "pass" | "fail";

/** The verdict a `probe` signal's text carries, and the error class it names. */
export function parseProbeText(text: string | undefined): { verdict: ProbeVerdict; errorClass: string | null } | undefined {
	if (text === undefined) return undefined;
	const match = /^(pass|fail)\b\s*([A-Za-z0-9._:-]*)/.exec(text.trim());
	if (match === null) return undefined;
	const errorClass = match[2] === undefined || match[2] === "" ? null : match[2];
	return { verdict: match[1] as ProbeVerdict, errorClass };
}

/**
 * The verdict the store's `probePassed` port and UM11's admission read: the
 * newest `probe` signal for this model, a `pass`, within the window (24 hours).
 * The provider and the model are normalized the way the store normalizes them,
 * so a case variant still finds the signal.
 */
export function probePassedFor(stateDir: string, provider: string, modelId: string, options: { now?: number; windowMs?: number } = {}): boolean {
	const nowMs = options.now ?? Date.now();
	const windowMs = options.windowMs ?? PROBE_PASS_WINDOW_MS;
	const normalizedProvider = normalizeProviderId(provider);
	const normalizedModel = modelId.trim().toLowerCase();
	const { signals } = readSignals(stateDir, { kind: "probe", limit: SIGNAL_READ_LIMIT_MAX });
	const newest = signals.filter((signal) => signal.provider === normalizedProvider && signal.modelId === normalizedModel).pop();
	if (newest === undefined) return false;
	const at = Date.parse(newest.at);
	if (Number.isNaN(at) || nowMs - at > windowMs) return false;
	return parseProbeText(newest.text)?.verdict === "pass";
}

/**
 * The port the gateway's `signals_add` hands the store for its free-launch ask
 * (`extensions/muster/gateway/tools.ts`). A read of the log, never a live probe:
 * no probe runs on the gateway's word.
 */
export function probePassedPort(stateDir: string): (provider: string, modelId: string) => boolean {
	return (provider, modelId) => probePassedFor(stateDir, provider, modelId);
}
