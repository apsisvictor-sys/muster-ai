/**
 * The packages' own test setup (OL12-D4, blueprint RD7): the one file a run loads before any test file.
 *
 * The guard stays in Pi's profile (RD7) and loads Pi's own setup, which points the `agentDir`
 * port at the checkout the run happens in — the behaviour every test on this machine has today.
 * A machine without the guard — the new repository's CI, which has no Pi profile at all — needs
 * a port of its own, so this one points `agentDir` at a scratch folder: the run reads nothing
 * from Pi's profile and writes nothing into it.
 *
 * `packages/test.sh` loads it with `--import`, before any test file, because some tests call
 * `piAgentDir()` while their module loads.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurePiPorts } from "./core/pi-ports.ts";

const scratch = mkdtempSync(join(tmpdir(), "harness-test-"));

configurePiPorts({ agentDir: scratch });

// The scratch folder is this run's own; it goes with the run.
process.on("exit", () => {
	try {
		rmSync(scratch, { recursive: true, force: true });
	} catch {
		// A scratch folder that survives is harmless.
	}
});
