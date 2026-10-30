/**
 * T5: the Concord custody check, read-only.
 *
 * The failure it exists for is silent, so the tests reproduce it for real rather
 * than with a stub: a child process holds a SQLite file open, the file is
 * unlinked and recreated under it, and every path-based reader would now see the
 * wrong bytes with nothing to report. The check compares the descriptor's inode
 * with the path's inode and says so.
 *
 * Everything here runs in temp directories: one real child process, one
 * temporary database, one fake `/proc` tree for the discovery scan. No Herdr, no
 * Hermes, no live `.concord`, no signal sent to anything.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { concordMcpPids, inspectConcordCustody } from "../concord-custody.ts";

/** A child that opens the database, says so, and waits to be killed. */
function holderProcess(dbPath: string): Promise<{ pid: number; stop: () => void }> {
	const script = `
		const fs = require("node:fs");
		const fd = fs.openSync(${JSON.stringify(dbPath)}, "r+");
		process.stdout.write("open\\n");
		process.stdout.write(String(fs.fstatSync(fd).ino) + "\\n");
		setInterval(() => {}, 1000);
	`;
	const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
	return new Promise((resolve, reject) => {
		let out = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`the holder never opened ${dbPath}: ${out}`));
		}, 10_000);
		child.stdout.on("data", (chunk: Buffer) => {
			out += chunk.toString("utf8");
			if (out.split("\n").filter((line) => line !== "").length >= 2) {
				clearTimeout(timer);
				resolve({ pid: child.pid as number, stop: () => child.kill("SIGKILL") });
			}
		});
		child.on("error", reject);
	});
}

function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "muster-custody-"));
	return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("T5: an intact database reads ok, and the holder is named", async () => {
	await withTempDir(async (dir) => {
		const dbPath = join(dir, "concord.db");
		writeFileSync(dbPath, "sqlite fixture");
		const holder = await holderProcess(dbPath);
		try {
			const custody = inspectConcordCustody({ dbPath, pids: [holder.pid] });
			assert.equal(custody.verdict, "ok", custody.summary);
			assert.equal(custody.holders.length, 1);
			assert.equal(custody.holders[0].pid, holder.pid);
			assert.equal(custody.holders[0].deleted, false);
			assert.equal(custody.holders[0].inode, custody.onDisk);
		} finally {
			holder.stop();
		}
	});
});

test("T5: an unlinked and recreated database is a split, and the summary says what to trust", async () => {
	await withTempDir(async (dir) => {
		const dbPath = join(dir, "concord.db");
		writeFileSync(dbPath, "the live database");
		const holder = await holderProcess(dbPath);
		try {
			const before = inspectConcordCustody({ dbPath, pids: [holder.pid] });
			assert.equal(before.verdict, "ok");

			// What a `git stash -u` / `pop` cycle does to a WAL database.
			unlinkSync(dbPath);
			writeFileSync(dbPath, "an older copy from the stash");

			const after = inspectConcordCustody({ dbPath, pids: [holder.pid] });
			assert.equal(after.verdict, "split", after.summary);
			assert.equal(after.holders[0].deleted, true, "the kernel marks the unlinked inode");
			assert.notEqual(after.holders[0].inode, after.onDisk, "the holder's inode is not the path's inode");
			assert.match(after.summary, /SPLIT/);
			assert.match(after.summary, new RegExp(`held by|hold ${after.holders[0].inode}`));
			assert.match(after.summary, /stale state/, "the summary names the trap the check exists for");
			assert.match(after.summary, /unlinked: \d+/);
		} finally {
			holder.stop();
		}
	});
});

test("T5: a holder of another concord.db is reported and never mistaken for a split", async () => {
	await withTempDir(async (dir) => {
		const dbPath = join(dir, "concord.db");
		writeFileSync(dbPath, "the live database");
		const otherRoot = join(dir, "other-project");
		mkdirSync(otherRoot, { recursive: true });
		writeFileSync(join(otherRoot, "concord.db"), "another project's live database");
		const procRoot = join(dir, "proc");
		mkdirSync(join(procRoot, "4242", "fd"), { recursive: true });
		writeFileSync(join(procRoot, "4242", "cmdline"), `${process.execPath}\u0000concord-mcp\u0000`);
		symlinkSync(join(otherRoot, "concord.db"), join(procRoot, "4242", "fd", "7"));
		const custody = inspectConcordCustody({ dbPath, procRoot });
		assert.equal(custody.verdict, "ok", custody.summary);
		assert.equal(custody.holders.length, 1, "the holder is still reported");
		assert.equal(custody.holders[0].atPath, false);
		assert.match(custody.summary, /not this project/);
	});
});

test("T5: no database at the path is missing, and stays missing when nothing holds one", async () => {
	await withTempDir(async (dir) => {
		const custody = inspectConcordCustody({ dbPath: join(dir, "concord.db"), pids: [], procRoot: join(dir, "no-proc") });
		assert.equal(custody.verdict, "missing");
		assert.match(custody.summary, /no database at/);
	});
});

test("T5: a database whose file vanished under a live holder is a split, not a missing", async () => {
	await withTempDir(async (dir) => {
		const dbPath = join(dir, "concord.db");
		writeFileSync(dbPath, "live");
		const holder = await holderProcess(dbPath);
		try {
			unlinkSync(dbPath);
			const custody = inspectConcordCustody({ dbPath, pids: [holder.pid] });
			assert.equal(custody.verdict, "split", custody.summary);
			assert.match(custody.summary, /nothing at/);
			assert.match(custody.summary, /no state at all/);
		} finally {
			holder.stop();
		}
	});
});

test("T5: with no known pid, the scan finds the concord-mcp holder through /proc", async () => {
	await withTempDir(async (dir) => {
		const dbPath = join(dir, "concord.db");
		writeFileSync(dbPath, "live");
		const procRoot = join(dir, "proc");
		// A fake /proc for a launcher whose descriptor points at the database. The
		// descriptor is a real symlink to the real file, so the inode comparison is
		// the real one.
		mkdirSync(join(procRoot, "4242", "fd"), { recursive: true });
		writeFileSync(join(procRoot, "4242", "cmdline"), `${process.execPath}\u0000/muster/launchers/concord-mcp\u0000`);
		symlinkSync(dbPath, join(procRoot, "4242", "fd", "7"));
		// A process that is not a launcher, so the scan must skip it.
		mkdirSync(join(procRoot, "4243", "fd"), { recursive: true });
		writeFileSync(join(procRoot, "4243", "cmdline"), `${process.execPath}\u0000some-other-tool\u0000`);
		symlinkSync(dbPath, join(procRoot, "4243", "fd", "3"));

		assert.deepEqual(concordMcpPids(procRoot), [4242]);
		const custody = inspectConcordCustody({ dbPath, procRoot });
		assert.equal(custody.verdict, "ok", custody.summary);
		assert.equal(custody.holders.length, 1);
		assert.equal(custody.holders[0].pid, 4242);
	});
});

test("T5: the scan finds the split when the descriptor is the deleted one at this path", async () => {
	await withTempDir(async (dir) => {
		const dbPath = join(dir, "concord.db");
		writeFileSync(dbPath, "an older copy from the stash");
		const procRoot = join(dir, "proc");
		mkdirSync(join(procRoot, "4242", "fd"), { recursive: true });
		writeFileSync(join(procRoot, "4242", "cmdline"), `${process.execPath}\u0000concord-mcp\u0000`);
		const live = join(dir, "live-inode.db");
		writeFileSync(live, "the live database");
		// The kernel's own rendering of an unlinked inode, as the descriptor's link.
		symlinkSync(live, join(dir, `${basename(dbPath)} (deleted)`));
		symlinkSync(join(dir, `${basename(dbPath)} (deleted)`), join(procRoot, "4242", "fd", "7"));

		const custody = inspectConcordCustody({ dbPath, procRoot });
		assert.equal(custody.verdict, "split", custody.summary);
		assert.equal(custody.holders[0].atPath, true);
		assert.equal(custody.holders[0].deleted, true);
		assert.match(custody.summary, /unlinked: 4242/);
	});
});

test("T5: a pid that has exited contributes nothing and never fails the check", async () => {
	await withTempDir(async (dir) => {
		const dbPath = join(dir, "concord.db");
		writeFileSync(dbPath, "live");
		const custody = inspectConcordCustody({ dbPath, pids: [999_999, 999_998] });
		assert.equal(custody.verdict, "ok", custody.summary);
		assert.deepEqual(custody.holders, []);
	});
});

test("T5: an unreadable proc tree leaves the verdict honest rather than split", async () => {
	await withTempDir(async (dir) => {
		const dbPath = join(dir, "concord.db");
		writeFileSync(dbPath, "live");
		const custody = inspectConcordCustody({ dbPath, procRoot: join(dir, "no-such-proc") });
		assert.equal(custody.verdict, "ok", custody.summary);
		assert.match(custody.summary, /no live MCP holds it/);
	});
});
