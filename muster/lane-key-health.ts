/**
 * The lane key health (KEYINJ P3): a lane cannot run on a provider key that resolves empty.
 *
 * The launch path already skips a provider it knows is unconfigured (VR24-213), but a lane that is already running, or
 * one started before its key was removed, ends its turn on "Failed to resolve API key" with nothing naming the lane
 * (2026-10-27). This module decides which live lanes to name; `muster-tick.mts` reads the machine and delivers the
 * alert, exactly as the duplicate guard does, so there is one health report and not a second one.
 *
 * A finding names the lane, its model and the key NAME, and nothing else: the answer comes from `accountConfigured`,
 * which is a boolean, so no value can be read out of here and printed into a tick line or a message.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { accountConfigured, accountKeyNames, untrustedAgentKeys, untrustedKeyReason, type UntrustedKey } from "../routing/provider-key.ts";
import { providerOf } from "../routing/provider-pool.ts";

/** What the pass needs from a lane row: its name, the model it runs, and whether it is up. */
export interface LaneKeyRow {
	laneId: string;
	model: string | null;
	/** Reader-set (`lane-directory.ts`): false when the lane's process is gone. An absent value is not a finding. */
	alive?: boolean;
}

/** One live lane whose key cannot be trusted. Only names: no value passes through this type. */
export interface LaneKeyFinding {
	lane: string;
	/** The model ref the lane runs, so the alert says what the key is for. */
	model: string;
	provider: string;
	/** The env name the provider's key is read through, in the order it is tried; this is the first of them. */
	name: string;
	/** `missing`: nothing resolves. `untrusted`: the file's value is still quoted, or is not the second copy's. */
	kind: "missing" | "untrusted";
	/** Why the value is untrusted, in name-and-length terms only; absent for `missing`. */
	reason?: string;
}

/**
 * Every live lane whose model's provider key resolves empty, or whose key value cannot be trusted.
 *
 * The account is the provider's own list: a lane card does not carry one, and a provider routed through an account
 * names that account's copy first (OpenCode Go's `ACCT2_OPENCODE_API_KEY`), so the name reported here is the one the
 * lane would need. A provider with no known name is never flagged: with no name, absence cannot be established
 * (VR24-213). A key that resolves but whose file value still carries a quote, or differs from the machine's second copy
 * of the same name, is flagged as untrusted, which is the 401 the quoted copy used to reach.
 */
export function laneKeyFindings(rows: readonly LaneKeyRow[], env: NodeJS.ProcessEnv = process.env): LaneKeyFinding[] {
	const findings: LaneKeyFinding[] = [];
	let untrusted: Map<string, UntrustedKey> | undefined;
	for (const row of rows) {
		if (row.alive === false) continue;
		const model = row.model?.trim() ?? "";
		if (model === "") continue;
		const provider = providerOf(model);
		const name = accountKeyNames(provider, undefined)[0];
		if (name === undefined) continue;
		if (!accountConfigured(provider, undefined, env)) {
			findings.push({ lane: row.laneId, model, provider, name, kind: "missing" });
			continue;
		}
		untrusted ??= untrustedAgentKeys();
		const suspect = untrusted.get(name);
		if (suspect !== undefined) findings.push({ lane: row.laneId, model, provider, name, kind: "untrusted", reason: untrustedKeyReason(name, suspect) });
	}
	return findings;
}

/** One line for the tick's own output: the lane, the provider and the NAME, and why a value is untrusted. */
export function laneKeyDetail(finding: LaneKeyFinding): string {
	return finding.kind === "missing" ? `no key: ${finding.lane} ${finding.provider} ${finding.name}` : `untrusted key: ${finding.lane} ${finding.provider} ${finding.reason ?? finding.name}`;
}

/** What the operator is told once per lane and name. */
export function laneKeyOperatorText(finding: LaneKeyFinding): string {
	return finding.kind === "missing"
		? `Lane ${finding.lane} runs ${finding.model} and its key ${finding.name} resolves empty, so its next request fails on a missing key. Nothing was restarted or changed.`
		: `Lane ${finding.lane} runs ${finding.model} and ${finding.reason ?? `its key ${finding.name} cannot be trusted`}, so its next request may fail on a bad key. Nothing was restarted or changed.`;
}

/** The identity of one finding: one lane and one name, however the model is written. */
export function laneKeyFindingKey(finding: LaneKeyFinding): string {
	return `${finding.lane}:${finding.name}`;
}

/** A finding reported this long ago is reported again, so a key that stays missing does not stay silent for ever. */
export const LANE_KEY_MEMORY_MS = 24 * 60 * 60 * 1000;

export function laneKeysReportedFile(musterStateDir: string): string {
	return join(musterStateDir, "lane-keys-reported.json");
}

/** The findings already reported: key to the time they were. An absent or unreadable file is "none". */
export function readReportedLaneKeys(musterStateDir: string): Record<string, number> {
	try {
		const file = laneKeysReportedFile(musterStateDir);
		if (!existsSync(file)) return {};
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
	} catch {
		return {};
	}
}

/** Remember that a finding was reported; entries older than `LANE_KEY_MEMORY_MS` are dropped on the way. */
export function markLaneKeyReported(musterStateDir: string, key: string, at: number): void {
	const kept = Object.fromEntries(Object.entries(readReportedLaneKeys(musterStateDir)).filter(([, reportedAt]) => at - reportedAt < LANE_KEY_MEMORY_MS));
	const file = laneKeysReportedFile(musterStateDir);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify({ ...kept, [key]: at }, null, 2), { mode: 0o600 });
	renameSync(tmp, file);
}

/** What the pass reads and does; the tick's own ports are the live ones, a test passes fakes. */
export interface LaneKeyPorts {
	now(): number;
	/** The findings of this moment; absent means no watch. */
	keyFindings?(): LaneKeyFinding[] | undefined;
	/** Has this finding been reported already? */
	keyReported?(key: string): boolean;
	markKeyReported?(key: string, at: number): void;
	/** One line into Henry's outbox. */
	tellOperator(text: string, key: string): void;
}

export interface LaneKeyResult {
	lane: string;
	action: string;
	detail: string;
}

/**
 * Tell the operator, once per lane and name, about every live lane whose key resolves empty. It changes nothing about the
 * lane: a missing key is the operator's to fix in `~/.config/agent-keys.env`, and the next launch reads it. A finding is
 * remembered only after the message went out, so a failed send is tried again at the next tick.
 */
export function laneKeyPass(ports: LaneKeyPorts, options: { dryRun?: boolean } = {}): LaneKeyResult[] {
	const results: LaneKeyResult[] = [];
	for (const finding of ports.keyFindings?.() ?? []) {
		const key = laneKeyFindingKey(finding);
		if (ports.keyReported?.(key) === true) continue;
		if (options.dryRun === true) {
			results.push({ lane: finding.lane, action: "lane-key-missing", detail: laneKeyDetail(finding) });
			continue;
		}
		try {
			ports.tellOperator(laneKeyOperatorText(finding), `lane-key:${key}`);
			ports.markKeyReported?.(key, ports.now());
			results.push({ lane: finding.lane, action: "lane-key-missing", detail: laneKeyDetail(finding) });
		} catch (error) {
			results.push({ lane: finding.lane, action: "lane-key-failed", detail: error instanceof Error ? error.message : String(error) });
		}
	}
	return results;
}
