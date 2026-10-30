#!/usr/bin/env node
/**
 * `musterd` entry point. Runs in the foreground; the systemd unit template
 * starts it and `Restart=always` reopens it after a crash.
 *
 *   node --import tsx/dist/loader.mjs scripts/musterd.mts
 *
 * The ledger and its socket live in the Muster state directory
 * (`state/muster`), or in `MUSTER_LEDGER_DIR` when that is set.
 */

import { startDaemon } from "../ledger/daemon.ts";
import { ledgerDir } from "../ledger/open.ts";

const daemon = await startDaemon(ledgerDir());
console.log(`musterd listening on ${daemon.socketPath}`);

let stopping = false;
const stop = async (signal: string): Promise<void> => {
	if (stopping) return;
	stopping = true;
	console.log(`musterd stopping on ${signal}`);
	try {
		await daemon.stop();
	} finally {
		process.exit(0);
	}
};

process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
