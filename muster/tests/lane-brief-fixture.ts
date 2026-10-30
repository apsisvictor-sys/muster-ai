/**
 * A launch brief outside /tmp. pi-lane-launch.sh refuses a brief under /tmp
 * (standing rule 2026-10-11: briefs live in handoffs/msgs), and the test labs
 * live in os.tmpdir(), so a brief fixture needs a home of its own.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function makeBrief(): { path: string; remove: () => void } {
	const root = join(homedir(), ".cache", "lane-launch-tests");
	mkdirSync(root, { recursive: true });
	const dir = mkdtempSync(join(root, "brief-"));
	const path = join(dir, "brief.md");
	writeFileSync(path, "# brief\n");
	return { path, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
