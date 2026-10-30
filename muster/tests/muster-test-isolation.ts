import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Default every external provider process boundary to a disposable rejecting fake. */
export function bindFakeMusterBinaries(): () => void {
	const dir = mkdtempSync(join(tmpdir(), "muster-fake-binaries-"));
	const keys = ["PATH", "HERDR_BIN_PATH", "PI_MUSTER_HERMES_BIN", "CONCORD_BIN_PATH", "PI_MUSTER_CONCORD_BIN", "PI_MUSTER_CONCORD_MCP_BIN"];
	const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	for (const name of ["herdr", "concord", "hermes"]) {
		const file = join(dir, name);
		writeFileSync(file, "#!/bin/sh\necho 'Unexpected provider invocation in isolated Muster test' >&2\nexit 97\n");
		chmodSync(file, 0o755);
	}
	Object.assign(process.env, { PATH: `${dir}:${process.env.PATH ?? ""}`, HERDR_BIN_PATH: join(dir, "herdr"),
		PI_MUSTER_HERMES_BIN: join(dir, "hermes"), CONCORD_BIN_PATH: join(dir, "concord"), PI_MUSTER_CONCORD_BIN: join(dir, "concord"), PI_MUSTER_CONCORD_MCP_BIN: join(dir, "concord") });
	return () => {
		for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
		rmSync(dir, { recursive: true, force: true });
	};
}

/**
 * Keep the generated the operator list (`asks.ts`, AK3) inside the OS temp dir. Without
 * an explicit path the writers would regenerate the tree's own copy
 * (`plans/orchestration-2026-10-05/handoffs/operator-only-list.md`), so a test that
 * raises an ask through the CLI or the gateway would edit the repository it runs in.
 */
export function bindOperatorListPath(): () => void {
	const dir = mkdtempSync(join(tmpdir(), "muster-operator-list-"));
	const saved = process.env.MUSTER_OPERATOR_LIST_PATH;
	if ((saved ?? "").trim() === "") process.env.MUSTER_OPERATOR_LIST_PATH = join(dir, "operator-only-list.md");
	return () => {
		if (saved === undefined) delete process.env.MUSTER_OPERATOR_LIST_PATH;
		else process.env.MUSTER_OPERATOR_LIST_PATH = saved;
		rmSync(dir, { recursive: true, force: true });
	};
}

// Node's test runner isolates files in child processes; bind before each file's
// imports/tests and restore its inherited environment at process teardown.
const restore = bindFakeMusterBinaries();
const restoreOperatorList = bindOperatorListPath();
process.once("exit", () => {
	restore();
	restoreOperatorList();
});
