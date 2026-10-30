/**
 * The receipt reader's own entry point: what the daily timer runs (UB0 B-2).
 *
 *     node --import file:///home/operator/.pi/agent/node_modules/tsx/dist/loader.mjs \
 *         /home/operator/.pi/agent/packages/muster/receipts/cli.ts
 *
 * One line per receipt on stdout and one line per run at the end. A run that reads nothing is not a
 * failure: a mailbox with no new receipt is the normal state, and a mailbox that did not answer has
 * already told the operator through its own ask.
 */

// RS3 F2: the unit runs this file directly, so this file is the receipt reader's start file. It imports the
// package profile's port wiring for its effect, before the module that reads a port: the reader's first line
// resolves `musterStateDir()`, which reads `agentDir`. A process nobody configured died there on every run
// (`PiPortMissing`; journalctl --user -u pi-receipts.service, 2026-10-28).
import "../../core/pi-ports-profile.ts";
import { runReceiptReader } from "./reader.ts";

export async function main(): Promise<number> {
	const result = await runReceiptReader({ log: (line) => process.stdout.write(`${line}\n`) });
	const read = result.profiles.reduce((sum, profile) => sum + profile.read, 0);
	const written = result.profiles.reduce((sum, profile) => sum + profile.written, 0);
	const silent = result.profiles.filter((profile) => profile.failed).map((profile) => profile.profile);
	process.stdout.write(
		`receipts: ${read} receipt${read === 1 ? "" : "s"} read, ${written} written${silent.length === 0 ? "" : `, no answer from ${silent.join(", ")}`}\n`,
	);
	return 0;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
	void main()
		.then((code) => process.exit(code))
		.catch((error: unknown) => {
			process.stderr.write(`receipts: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
			process.exit(1);
		});
}
