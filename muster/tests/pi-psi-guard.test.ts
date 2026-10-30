import "./muster-test-isolation.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { harnessRoot } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);

/**
 * Memory-pressure guard and heavy-launch gate (Henry priority 1, 2026-10-19). The guard kills the largest
 * unit under pi.slice after sustained pressure and never a protected one; the gate refuses a heavy start
 * during a dev-server window, under pressure or with pi.slice nearly full. Both run against fake
 * pressure files and a fake cgroup tree with a fake kill command: no real unit is touched.
 */

const SCRIPTS = join(piAgentDir(), "scripts");

function psiFile(dir: string, avg10: number): string {
	const path = join(dir, "pressure");
	writeFileSync(path, `some avg10=${avg10.toFixed(2)} avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`);
	return path;
}

function fakeTree(dir: string, units: Record<string, number>, withKillFile = false): string {
	const root = join(dir, "pi.slice");
	for (const [name, bytes] of Object.entries(units)) {
		const unit = join(root, "pi-lanes.slice", name);
		mkdirSync(unit, { recursive: true });
		writeFileSync(join(unit, "memory.current"), `${bytes}\n`);
		if (withKillFile) writeFileSync(join(unit, "cgroup.kill"), "");
	}
	return root;
}

function runGuard(dir: string, psi: number, units: Record<string, number>, extra: Record<string, string> = {}, withKillFile = false) {
	const killed = join(dir, "killed");
	const log = join(dir, "guard.log");
	const run = spawnSync("python3", ["-I", join(SCRIPTS, "pi-psi-guard.py")], {
		encoding: "utf8",
		env: {
			PATH: process.env.PATH ?? "",
			HOME: dir,
			PSI_GUARD_PSI_FILE: psiFile(dir, psi),
			PSI_GUARD_ROOT: fakeTree(dir, units, withKillFile),
			PSI_GUARD_KILL_CMD: `sh -c 'echo {unit} >> ${killed}'`,
			PSI_GUARD_NOTIFY_CMD: "",
			PSI_GUARD_LOG: log,
			PSI_GUARD_INTERVAL: "0.05",
			PSI_GUARD_KILL_SECONDS: "0.3",
			PSI_GUARD_ALERT_SECONDS: "0.3",
			PSI_GUARD_COOLDOWN: "30",
			PSI_GUARD_MAX_SECONDS: "1.2",
			...extra,
		},
	});
	assert.equal(run.status, 0, run.stderr);
	const read = (path: string) => {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return "";
		}
	};
	return { killed: read(killed).split("\n").filter(Boolean), log: read(log) };
}

test("sustained pressure kills the largest unit once, then stays quiet through the cooldown", () => {
	const dir = mkdtempSync(join(tmpdir(), "psi-guard-"));
	const { killed, log } = runGuard(dir, 55, { "be-dev-server-a.scope": 5e9, "lane-x.scope": 2e9, "pi-test-suite-guarded.service": 3e9 });
	assert.deepEqual(killed, ["be-dev-server-a.scope"]);
	assert.match(log, /PSI KILL be-dev-server-a\.scope mem=\d+MiB psi10=55\.0/);
});

test("pressure below the kill line, or too short, kills nothing", () => {
	const dir = mkdtempSync(join(tmpdir(), "psi-guard-"));
	assert.deepEqual(runGuard(dir, 39, { "be-dev-server-a.scope": 5e9 }).killed, []);
	const short = runGuard(mkdtempSync(join(tmpdir(), "psi-guard-")), 80, { "be-dev-server-a.scope": 5e9 }, { PSI_GUARD_KILL_SECONDS: "30" });
	assert.deepEqual(short.killed, []);
});

test("a protected unit is never the victim even when it is the largest", () => {
	const dir = mkdtempSync(join(tmpdir(), "psi-guard-"));
	const { killed } = runGuard(dir, 90, { "muster-gateway.service": 9e9, "grokbot-tunnel.service": 8e9, "gateway-watchdog.service": 7e9, "lane-y.scope": 1e9 });
	assert.deepEqual(killed, ["lane-y.scope"]);
});

// 2026-10-21: 28 of 28 kills failed with rc=1 because `systemctl --user kill` waits on a user manager that
// the same pressure starves. The guard now writes the unit's cgroup.kill itself and keeps the command as
// the fallback, logging its error.
test("the kill goes straight to the unit's cgroup.kill, without the command", () => {
	const dir = mkdtempSync(join(tmpdir(), "psi-guard-"));
	const { killed, log } = runGuard(dir, 55, { "lane-big.scope": 5e9, "lane-small.scope": 1e9 }, {}, true);
	assert.deepEqual(killed, []);
	assert.equal(readFileSync(join(dir, "pi.slice", "pi-lanes.slice", "lane-big.scope", "cgroup.kill"), "utf8").trim(), "1");
	assert.equal(readFileSync(join(dir, "pi.slice", "pi-lanes.slice", "lane-small.scope", "cgroup.kill"), "utf8"), "");
	assert.match(log, /PSI KILL lane-big\.scope mem=\d+MiB psi10=55\.0 \(killed=yes via=cgroup\.kill\)/);
});

// VR21-42 S5: every kill is one event line in the orchestrator events log, naming unit, size, PSI and
// what the kill did, beside the guard's own log and the orchestrator notify.
test("every kill is appended to the orchestrator events log as one event line", () => {
	const dir = mkdtempSync(join(tmpdir(), "psi-guard-events-"));
	const events = join(dir, "events.log");
	const { log } = runGuard(dir, 55, { "lane-big.scope": 5e9, "lane-small.scope": 1e9 }, { PSI_GUARD_EVENTS_LOG: events }, true);
	assert.match(log, /PSI KILL lane-big\.scope/);
	const line = readFileSync(events, "utf8").split("\n").filter((row) => row.includes("PSI KILL:"));
	assert.equal(line.length, 1);
	assert.match(line[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2} PSI KILL: lane-big\.scope mem=\d+MiB psi10=55\.0 \(killed=yes via=cgroup\.kill\)$/);
});

test("a failing fallback kill command is logged with its error", () => {
	const dir = mkdtempSync(join(tmpdir(), "psi-guard-"));
	const { log } = runGuard(dir, 55, { "lane-big.scope": 5e9 }, { PSI_GUARD_KILL_CMD: "sh -c 'echo bus call timed out >&2; exit 1'" });
	assert.match(log, /PSI KILL lane-big\.scope .*\(killed=no rc=1 via=command: bus call timed out\)/);
});

test("pressure above the alert line for long enough writes an ALERT line", () => {
	const dir = mkdtempSync(join(tmpdir(), "psi-guard-"));
	const { log } = runGuard(dir, 70, { "lane-z.scope": 1e9 });
	assert.match(log, /ALERT psi10=70\.0 above 60/);
});

// 2026-10-22 02:24-02:34 (PSI1): the guard acted 9 minutes after pressure crossed its lines, though its rule was met
// on time. The pass that finally fired spent 190 s before its first log stamp and 141 s inside the ALERT write
// (file stamp 02:31:36, journal line 02:33:57.504) before it reached the kill it had already earned. A log write
// that blocks must not hold the kill back. A FIFO without a reader blocks a write the way a memory stall does.
test("a log write that blocks does not hold the kill back", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psi-guard-stall-"));
	const fifo = join(dir, "guard.fifo");
	assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
	const killed = join(dir, "killed");
	const child = spawn("python3", ["-I", join(SCRIPTS, "pi-psi-guard.py")], {
		stdio: "ignore",
		env: {
			PATH: process.env.PATH ?? "",
			HOME: dir,
			PSI_GUARD_PSI_FILE: psiFile(dir, 90),
			PSI_GUARD_ROOT: fakeTree(dir, { "lane-big.scope": 5e9, "lane-small.scope": 1e9 }),
			PSI_GUARD_KILL_CMD: `sh -c 'echo {unit} >> ${killed}'`,
			PSI_GUARD_NOTIFY_CMD: "",
			PSI_GUARD_EVENTS_LOG: join(dir, "events.log"),
			PSI_GUARD_LOG: fifo,
			PSI_GUARD_INTERVAL: "0.05",
			PSI_GUARD_KILL_SECONDS: "0.3",
			PSI_GUARD_ALERT_SECONDS: "0.3",
			PSI_GUARD_COOLDOWN: "30",
		},
	});
	const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	try {
		// Let the start line through, then leave the FIFO without a reader: every later log write blocks.
		const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
		const buffer = Buffer.alloc(512);
		let got = 0;
		for (let waited = 0; got === 0 && waited < 5000; waited += 20) {
			try {
				got = readSync(reader, buffer, 0, buffer.length, null);
			} catch {
				got = 0;
			}
			if (got === 0) await wait(20);
		}
		closeSync(reader);
		assert.ok(got > 0, "the guard never wrote its start line");
		for (let waited = 0; !existsSync(killed) && waited < 4000; waited += 50) await wait(50);
		assert.equal(existsSync(killed) ? readFileSync(killed, "utf8").trim() : "", "lane-big.scope", "the kill waited behind the blocked log write");
	} finally {
		child.kill("SIGKILL");
	}
});

// The same pass read its pressure 190 s after it took its time stamp. The unit's MemoryLow=64M protected nothing:
// the kernel limits a child's low to its parent's, and app.slice has memory.low 0 (its floor is memory.min, see
// app.slice.d/10-gateway-floor.conf). The guard's cgroup showed 374 s of memory stall and 5 MB of its pages in swap.
// MemoryMin counts up to app.slice's 1G floor (three units at 256M plus the guard fit) for reclaim inside
// user-1000.slice only (user.slice has memory.min 0, PSI1 F1), and swap is refused.
test("the guard unit asks for a memory floor and for no swap", () => {
	const unit = readFileSync(join(SCRIPTS, "..", "systemd", "pi-psi-guard.service"), "utf8");
	const setting = (name: string) =>
		unit
			.split("\n")
			.filter((line) => !line.startsWith("#"))
			.map((line) => line.match(new RegExp(`^${name}=(.*)$`))?.[1])
			.find((value) => value !== undefined);
	assert.match(setting("MemoryMin") ?? "", /^\d+M$/, "MemoryMin");
	assert.equal(setting("MemorySwapMax"), "0");
});

// The guard pins its own pages (mlockall) so that reading the pressure and writing cgroup.kill never wait on a
// page-in. The machine's limit is 64 MB; the lab script reads VmLck of a lab guard under the unit's properties.
test("the guard pins its pages and says so in its start line", () => {
	const limit = spawnSync("sh", ["-c", "ulimit -l"], { encoding: "utf8" }).stdout.trim();
	if (limit !== "unlimited" && Number(limit) < 65536) return;
	const dir = mkdtempSync(join(tmpdir(), "psi-guard-"));
	const { log } = runGuard(dir, 10, { "lane-x.scope": 1e9 }, { PSI_GUARD_MAX_SECONDS: "0.3" });
	assert.match(log, / start kill>40 .* mlockall=yes/);
});

function meminfoFile(dir: string, availableMb: number): string {
	const file = join(dir, "meminfo");
	writeFileSync(file, `MemTotal:       20480000 kB\nMemAvailable:   ${availableMb * 1024} kB\n`);
	return file;
}

function runGate(dir: string, opts: { servers?: string; psi?: number; current?: number; high?: number; override?: boolean; availableMb?: number; size?: string }) {
	const slice = join(dir, "slice");
	mkdirSync(slice, { recursive: true });
	writeFileSync(join(slice, "memory.current"), `${opts.current ?? 1e9}\n`);
	writeFileSync(join(slice, "memory.high"), `${opts.high ?? 11e9}\n`);
	return spawnSync("bash", [join(SCRIPTS, "heavy-gate.sh"), "lane-launch", ...(opts.size ? [opts.size] : [])], {
		encoding: "utf8",
		env: {
			PATH: process.env.PATH ?? "",
			HOME: dir,
			HEAVY_GATE_UNITS_CMD: opts.servers ? `echo ${opts.servers}` : "true",
			HEAVY_GATE_PSI_FILE: psiFile(dir, opts.psi ?? 0),
			HEAVY_GATE_SLICE_DIR: slice,
			HEAVY_GATE_LOG: join(dir, "gate.log"),
			HEAVY_GATE_MEMINFO_FILE: meminfoFile(dir, opts.availableMb ?? 12288),
			HEAVY_GATE_LAST: join(dir, "last-lane-launch"),
			...(opts.override ? { PI_HEAVY_GATE_OVERRIDE: "1" } : {}),
		},
	});
}

test("the gate lets a heavy start through on an idle machine", () => {
	assert.equal(runGate(mkdtempSync(join(tmpdir(), "gate-")), {}).status, 0);
});

test("the gate refuses during a dev-server window, under pressure and with pi.slice nearly full", () => {
	const window = runGate(mkdtempSync(join(tmpdir(), "gate-")), { servers: "be-dev-server-7.scope" });
	assert.equal(window.status, 75);
	assert.match(window.stderr, /dev-server window open \(be-dev-server-7\.scope\)/);
	const pressure = runGate(mkdtempSync(join(tmpdir(), "gate-")), { psi: 20 });
	assert.equal(pressure.status, 75);
	assert.match(pressure.stderr, /memory pressure avg10 20\.00/);
	const full = runGate(mkdtempSync(join(tmpdir(), "gate-")), { current: 9e9, high: 11e9 });
	assert.equal(full.status, 75);
	assert.match(full.stderr, /pi\.slice holds/);
});

test("an explicit override passes the gate", () => {
	assert.equal(runGate(mkdtempSync(join(tmpdir(), "gate-")), { servers: "be-dev-server-7.scope", override: true }).status, 0);
});

test("the memory floor must cover the reserve plus the job's measured size (VR21-42 S1)", () => {
	// lane-launch is measured from the lane scopes' memory.peak, largest 1498 MiB
	// (lane-stagesel-1792613403.scope, 2026-10-21): the 6144 MiB reserve plus 1498 MiB of job
	// size must be free before a launch is admitted.
	const low = runGate(mkdtempSync(join(tmpdir(), "gate-")), { availableMb: 3000 });
	assert.equal(low.status, 75);
	assert.match(low.stderr, /only 3000 MiB of memory is available, under 7642 for the 1498 MiB job plus the 6144 MiB session reserve/);
	assert.equal(runGate(mkdtempSync(join(tmpdir(), "gate-")), { availableMb: 8000 }).status, 0);
	const mid = runGate(mkdtempSync(join(tmpdir(), "gate-")), { availableMb: 6144 });
	assert.equal(mid.status, 75);
	assert.match(mid.stderr, /under 7642/);
});

test("the wait-out exit follows the caller's contract: 42 to the runner, 75 to the launchers", () => {
	// pi-lane-launch.sh propagates the refusal code and muster's launch retry defers on 75, so a
	// lane launch keeps exit 75 exactly as since the first gate; only a test run's own caller
	// (run-guarded.sh's lock-free poll) waits on 42, the runner's existing refusal code.
	const dir = mkdtempSync(join(tmpdir(), "gate-exit-"));
	assert.equal(runGateKind("lane-launch", dir, 1000).status, 75);
	assert.equal(runGateKind("test-run", dir, 1000).status, 42);
	assert.equal(runGateKind("graph-refresh", dir, 1000).status, 75);
});

test("a second lane launch inside the 60 second spacing is refused, and other kinds are not spaced", () => {
	const dir = mkdtempSync(join(tmpdir(), "gate-"));
	assert.equal(runGate(dir, {}).status, 0);
	const second = runGate(dir, {});
	assert.equal(second.status, 75);
	assert.match(second.stderr, /another lane launch passed the gate \d+s ago \(spacing 60s\)/);
	const graph = spawnSync("bash", [join(SCRIPTS, "heavy-gate.sh"), "graph-refresh"], {
		encoding: "utf8",
		env: {
			PATH: process.env.PATH ?? "",
			HOME: dir,
			HEAVY_GATE_UNITS_CMD: "true",
			HEAVY_GATE_PSI_FILE: psiFile(dir, 0),
			HEAVY_GATE_MEMINFO_FILE: meminfoFile(dir, 12288),
			HEAVY_GATE_LAST: join(dir, "last-lane-launch"),
			HEAVY_GATE_LOG: join(dir, "gate.log"),
		},
	});
	assert.equal(graph.status, 0, graph.stderr);
});

function runGateKind(kind: string, dir: string, availableMb: number, extra: Record<string, string> = {}, size?: string) {
	return spawnSync("bash", [join(SCRIPTS, "heavy-gate.sh"), kind, ...(size ? [size] : [])], {
		encoding: "utf8",
		env: {
			PATH: process.env.PATH ?? "",
			HOME: dir,
			HEAVY_GATE_UNITS_CMD: "true",
			HEAVY_GATE_PSI_FILE: psiFile(dir, 0),
			HEAVY_GATE_SLICE_DIR: join(dir, "no-slice"),
			HEAVY_GATE_MEMINFO_FILE: meminfoFile(dir, availableMb),
			HEAVY_GATE_LOG: join(dir, "gate.log"),
			HEAVY_GATE_EVENTS_LOG: join(dir, "events.log"),
			HEAVY_GATE_REFUSED_STATE_DIR: dir,
			...extra,
		},
	});
}

// The acceptance for VR21-42 S1: two guarded run jobs of the measured kind cannot both be
// admitted at once; the second is refused with 42 so its caller waits.
test("a full-size test run passes and a second one is refused with 42 until memory frees", () => {
	const dir = mkdtempSync(join(tmpdir(), "gate-size-"));
	const first = runGateKind("test-run", dir, 13000);
	assert.equal(first.status, 0, first.stderr);
	const second = runGateKind("test-run", dir, 10000);
	assert.equal(second.status, 42);
	assert.match(second.stderr, /under 10744 for the 4600 MiB job/);
	// The gate's own log lines carry the arithmetic, so the lab proof reads from them.
	const gateLog = readFileSync(join(dir, "gate.log"), "utf8");
	assert.match(gateLog, /admitted kind=test-run size=4600MiB available=13000MiB need=10744MiB/);
	assert.match(gateLog, /refused kind=test-run size=4600MiB/);
});

test("a declared size overrides the table and decides the bar", () => {
	const dir = mkdtempSync(join(tmpdir(), "gate-declared-"));
	const under = runGateKind("test-run", dir, 10800, {}, "4700");
	assert.equal(under.status, 42, under.stderr);
	assert.match(under.stderr, /under 10844 for the 4700 MiB job/);
	const over = runGateKind("test-run", dir, 11000, {}, "4700");
	assert.equal(over.status, 0, over.stderr);
	assert.match(readFileSync(join(dir, "gate.log"), "utf8"), /admitted kind=test-run size=4700MiB/);
});

test("a declared size that is not whole MiB is refused, not silently tabled", () => {
	const dir = mkdtempSync(join(tmpdir(), "gate-badsize-"));
	const bad = runGateKind("test-run", dir, 20000, {}, "4.7");
	assert.equal(bad.status, 42);
	assert.match(bad.stderr, /declared size 4\.7 is not a whole number of MiB/);
});

test("a refusal episode older than 10 minutes becomes one gate refusal event per window (VR21-42 S5)", () => {
	const dir = mkdtempSync(join(tmpdir(), "gate-event-"));
	const marker = join(dir, "heavy-gate.refused.test-run");
	writeFileSync(marker, `${Math.floor(Date.now() / 1000) - 700}\n`);
	const refused = runGateKind("test-run", dir, 3000);
	assert.equal(refused.status, 42);
	const events = readFileSync(join(dir, "events.log"), "utf8");
	assert.match(events, /GATE REFUSAL: unit=test-run size=4600MiB psi=0\.00 reason="/);
	const again = runGateKind("test-run", dir, 3000);
	assert.equal(again.status, 42);
	assert.equal((readFileSync(join(dir, "events.log"), "utf8").match(/GATE REFUSAL/g) ?? []).length, 1);
});

// --- WP2: --status, the gate's own read-only view; WP3: the pause flag ---

/** The pause flag as `heavy-gate-pause.sh` writes it: who first, when second. */
function pauseFlag(dir: string, text = "the operator 2026-10-22T03:00:00+03:00"): string {
	const flag = join(dir, "paused.flag");
	writeFileSync(flag, `${text}\n`);
	return flag;
}

/** A run of `heavy-gate.sh --status` against the same fixtures the refusal runs use. */
function runStatus(dir: string, opts: { servers?: string; psi?: number; current?: number; high?: number; availableMb?: number; override?: boolean; psiMissing?: boolean } = {}) {
	const slice = join(dir, "slice");
	mkdirSync(slice, { recursive: true });
	writeFileSync(join(slice, "memory.current"), `${opts.current ?? 1e9}\n`);
	writeFileSync(join(slice, "memory.high"), `${opts.high ?? 11e9}\n`);
	return spawnSync("bash", [join(SCRIPTS, "heavy-gate.sh"), "--status"], {
		encoding: "utf8",
		env: {
			PATH: process.env.PATH ?? "",
			HOME: dir,
			HEAVY_GATE_UNITS_CMD: opts.servers ? `echo ${opts.servers}` : "true",
			HEAVY_GATE_PSI_FILE: opts.psiMissing ? join(dir, "missing-psi") : psiFile(dir, opts.psi ?? 0),
			HEAVY_GATE_SLICE_DIR: slice,
			HEAVY_GATE_LOG: join(dir, "gate.log"),
			HEAVY_GATE_MEMINFO_FILE: meminfoFile(dir, opts.availableMb ?? 12288),
			HEAVY_GATE_LAST: join(dir, "last-lane-launch"),
			HEAVY_GATE_EVENTS_LOG: join(dir, "events.log"),
			HEAVY_GATE_REFUSED_STATE_DIR: dir,
			HEAVY_GATE_PAUSED_FILE: join(dir, "paused.flag"),
			...(opts.override ? { PI_HEAVY_GATE_OVERRIDE: "1" } : {}),
		},
	});
}

/** One refusal's reason text, cut from stderr: the gate's own words, nothing more. */
function refusalReason(stderr: string): string {
	const match = /^heavy-gate: \S+ refused: (.*) \(set PI_HEAVY_GATE_OVERRIDE/.exec(stderr);
	assert.ok(match !== null, `not a refusal line: ${JSON.stringify(stderr)}`);
	return match[1]!;
}

test("--status answers one JSON line, always exits 0 and records nothing (WP2)", () => {
	const dir = mkdtempSync(join(tmpdir(), "gate-status-"));
	const run = runStatus(dir, {});
	assert.equal(run.status, 0, run.stderr);
	assert.equal(run.stdout.split("\n").length, 2); // one JSON line and its newline
	const view = JSON.parse(run.stdout) as Record<string, unknown>;
	assert.equal(Object.keys(view).join(","), "wouldAdmit,reason,psi,availableMb,sliceUsedPct,paused,devServerWindow");
	assert.equal(view.wouldAdmit, true);
	assert.equal(view.reason, "");
	assert.equal(view.psi, 0);
	assert.equal(view.availableMb, 12288);
	assert.equal(view.sliceUsedPct, 9);
	assert.equal(view.paused, false);
	assert.equal(view.devServerWindow, "");
	// records nothing: no log line, no lane-launch slot, no refusal marker, no event
	assert.equal(existsSync(join(dir, "gate.log")), false);
	assert.equal(existsSync(join(dir, "last-lane-launch")), false);
	assert.equal(existsSync(join(dir, "events.log")), false);
	assert.equal(existsSync(join(dir, "heavy-gate.refused.lane-launch")), false);
	// a psi value comes as a number; an unreadable pressure file stays a valid answer with null
	const dark = runStatus(mkdtempSync(join(tmpdir(), "gate-status-dark-")), { psiMissing: true });
	assert.equal(dark.status, 0, dark.stderr);
	assert.equal((JSON.parse(dark.stdout) as Record<string, unknown>).psi, null);
});

test("--status and a refusal name the same rule with the same words for the same inputs (WP2)", () => {
	// dev-server window
	const windowDir = mkdtempSync(join(tmpdir(), "gate-parity-window-"));
	const windowRun = runGate(windowDir, { servers: "be-dev-server-7.scope" });
	assert.equal(windowRun.status, 75);
	assert.equal(
		(JSON.parse(runStatus(mkdtempSync(join(tmpdir(), "gate-parity-window-status-")), { servers: "be-dev-server-7.scope" }).stdout) as Record<string, unknown>).reason,
		refusalReason(windowRun.stderr),
	);
	// pressure
	const psiDir = mkdtempSync(join(tmpdir(), "gate-parity-psi-"));
	const psiRun = runGate(psiDir, { psi: 20 });
	assert.equal(psiRun.status, 75);
	assert.equal(
		(JSON.parse(runStatus(mkdtempSync(join(tmpdir(), "gate-parity-psi-status-")), { psi: 20 }).stdout) as Record<string, unknown>).reason,
		refusalReason(psiRun.stderr),
	);
	// pi.slice nearly full
	const sliceDir = mkdtempSync(join(tmpdir(), "gate-parity-slice-"));
	const sliceRun = runGate(sliceDir, { current: 9e9, high: 11e9 });
	assert.equal(sliceRun.status, 75);
	assert.equal(
		(JSON.parse(runStatus(mkdtempSync(join(tmpdir(), "gate-parity-slice-status-")), { current: 9e9, high: 11e9 }).stdout) as Record<string, unknown>).reason,
		refusalReason(sliceRun.stderr),
	);
	// the pause flag, with the dev-server window also open: the pause is first
	const pauseDir = mkdtempSync(join(tmpdir(), "gate-parity-pause-"));
	const pauseRun = runGateKind("lane-launch", pauseDir, 20000, {
		HEAVY_GATE_PAUSED_FILE: pauseFlag(pauseDir),
		HEAVY_GATE_UNITS_CMD: "echo be-dev-server-7.scope",
	});
	assert.equal(pauseRun.status, 75);
	const pauseStatusDir = mkdtempSync(join(tmpdir(), "gate-parity-pause-status-"));
	pauseFlag(pauseStatusDir);
	assert.equal(
		(JSON.parse(runStatus(pauseStatusDir, { servers: "be-dev-server-7.scope" }).stdout) as Record<string, unknown>).reason,
		refusalReason(pauseRun.stderr),
	);
	// the memory floor for a 0 MiB job names the reserve alone; the table-size refusals differ by design
	const floorDir = mkdtempSync(join(tmpdir(), "gate-parity-floor-"));
	const floorView = JSON.parse(runStatus(mkdtempSync(join(tmpdir(), "gate-parity-floor-status-")), { availableMb: 3000 }).stdout) as Record<string, unknown>;
	assert.match(String(floorView.reason), /only 3000 MiB of memory is available, under 6144 for the 0 MiB job plus the 6144 MiB session reserve/);
});

test("--status with the override says the gate would admit, unless even the reserve floor fails (WP2)", () => {
	const open = runStatus(mkdtempSync(join(tmpdir(), "gate-status-override-")), { servers: "be-dev-server-7.scope", override: true });
	const openView = JSON.parse(open.stdout) as Record<string, unknown>;
	assert.equal(openView.wouldAdmit, true); // the override ignores the window, as the gate does
	assert.equal(openView.reason, "");
	const floor = runStatus(mkdtempSync(join(tmpdir(), "gate-status-override-floor-")), { servers: "be-dev-server-7.scope", override: true, availableMb: 3000 });
	const floorView = JSON.parse(floor.stdout) as Record<string, unknown>;
	assert.equal(floorView.wouldAdmit, false);
	assert.match(String(floorView.reason), /^only 3000 MiB of memory is available, under 6144$/);
});

test("a paused gate refuses a test run with 42 and a lane launch with 75, and admits both after resume (WP3)", () => {
	const dir = mkdtempSync(join(tmpdir(), "gate-pause-"));
	const flag = pauseFlag(dir);
	const testRun = runGateKind("test-run", dir, 20000, { HEAVY_GATE_PAUSED_FILE: flag });
	assert.equal(testRun.status, 42, testRun.stderr);
	assert.match(testRun.stderr, /refused: paused by the operator at 2026-10-22T03:00:00\+03:00 /);
	const launch = runGateKind("lane-launch", dir, 20000, { HEAVY_GATE_PAUSED_FILE: flag });
	assert.equal(launch.status, 75, launch.stderr);
	assert.match(launch.stderr, /refused: paused by the operator at 2026-10-22T03:00:00\+03:00 /);
	// the pauses recorded nothing: no lane-launch slot is burned while the gate is paused
	assert.equal(existsSync(join(dir, "last-lane-launch")), false);
	// resume: the flag gone, both are admitted again
	unlinkSync(flag);
	assert.equal(runGateKind("test-run", dir, 13000).status, 0);
	assert.equal(runGateKind("lane-launch", dir, 8000).status, 0);
});

test("the pause precedes PI_HEAVY_GATE_OVERRIDE: a stopped gate is not bypassable (WP3)", () => {
	const dir = mkdtempSync(join(tmpdir(), "gate-pause-override-"));
	const refused = runGateKind("lane-launch", dir, 20000, { HEAVY_GATE_PAUSED_FILE: pauseFlag(dir), PI_HEAVY_GATE_OVERRIDE: "1" });
	assert.equal(refused.status, 75, refused.stderr);
	assert.match(refused.stderr, /refused: paused by the operator at /);
});

test("heavy-gate-pause.sh writes who and when, and resume removes the flag (WP3)", () => {
	const dir = mkdtempSync(join(tmpdir(), "gate-pause-helper-"));
	const flag = join(dir, "flag");
	const env = { PATH: process.env.PATH ?? "", HEAVY_GATE_PAUSED_FILE: flag };
	const pause = spawnSync("bash", [join(SCRIPTS, "heavy-gate-pause.sh"), "pause"], { encoding: "utf8", env });
	assert.equal(pause.status, 0, pause.stderr);
	assert.match(readFileSync(flag, "utf8"), /^\S+ \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	const resume = spawnSync("bash", [join(SCRIPTS, "heavy-gate-pause.sh"), "resume"], { encoding: "utf8", env });
	assert.equal(resume.status, 0, resume.stderr);
	assert.equal(existsSync(flag), false);
	const bad = spawnSync("bash", [join(SCRIPTS, "heavy-gate-pause.sh")], { encoding: "utf8", env });
	assert.equal(bad.status, 2);
});

