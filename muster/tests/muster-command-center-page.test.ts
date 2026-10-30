import "./muster-test-isolation.ts";
/**
 * The command center page (WP1b): what the listener serves, the assets route, the page's own colour and label
 * maps, and the guarantees acceptance 2, 3, 5 and 6 of the blueprint's WP1b section name. The browser half
 * (screenshots, restart, keyboard, the rendered contrast) is `cc-page-qa.mjs`, which drives the same page file.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
	CC_ASSETS,
	CC_ASSETS_PATH,
	commandCenter,
	createCommandCenterHandler,
	STALE_ASK_MS,
	type CommandCenterDeps,
	type CommandCenterListener,
	type GateStatus,
	type MessagesPort,
	type PsiKill,
	type Whois
} from "../gateway/command-center.ts";
import { ASK_KINDS } from "../asks.ts";
import { GOAL_COLOURS } from "../goals.ts";
import { LANE_STAGES } from "../lane-stage.ts";
import { PROVIDER_LABELS } from "../gateway/command-center-panels.ts";
import type { LaneCard } from "../lib/lane-card.ts";
import { harnessRoot } from "../../core/harness-paths.ts";
import { piAgentDir } from "../../core/pi-ports.ts";

const HARNESS_ROOT = harnessRoot(import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE_FILE = join(HERE, "..", "gateway", "command-center-page.html");
const PAGE = readFileSync(PAGE_FILE, "utf8");
const OPERATOR = "operator@example.test";
const NODE_PHONE = "node-phone";
const NODE_SELF = "node-self";
const GATE_OK: GateStatus = { wouldAdmit: true, reason: "", psi: 0, availableMb: 9000, sliceUsedPct: 10, paused: false, devServerWindow: "" };

const REPLY = { status: 0, text: "", headers: {} as Record<string, string>, json: (): any => JSON.parse("{}") };

function request(port: number, path: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<typeof REPLY> {
	return new Promise((done, fail) => {
		const req = httpRequest({ host: "127.0.0.1", port, agent: false, method: options.method ?? "GET", path, headers: options.headers ?? {} }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => {
				const text = Buffer.concat(chunks).toString("utf8");
				done({ status: res.statusCode ?? 0, text, headers: res.headers as Record<string, string>, json: () => JSON.parse(text) });
			});
		});
		req.on("error", fail);
		req.end();
	});
}

function deps(over: Partial<CommandCenterDeps> = {}): CommandCenterDeps {
	const card: LaneCard = { laneId: "census", harness: "pi", cwd: "/w", branch: "lane/census", state: "running", model: "m", thinking: null, since: 1, updatedAt: 1, wall: null, origin: "auto", alive: true };
	return {
		stateDir: "/nonexistent-state",
		home: "/nonexistent-home",
		now: () => new Date("2026-10-25T01:30:00.000Z"),
		lanes: () => [card],
		scopeUnits: () => [],
		briefTitle: () => undefined,
		gateStatus: async () => GATE_OK,
		psiKills: (): PsiKill[] => [],
		asks: () => [],
		closeLane: async () => ({ ok: true, detail: "" }),
		heavyJobs: async () => ({ ok: true, detail: "" }),
		...over
	};
}

/** The real listener and the real handler on an ephemeral port, with whois stubbed as tailscaled would answer. */
async function withListener(run: (port: number, refusals: string[]) => Promise<void>, whois: Whois = async () => ({ login: OPERATOR, nodeId: NODE_PHONE })): Promise<void> {
	const center = commandCenter(deps());
	const refusals: string[] = [];
	const listener: CommandCenterListener = { host: "127.0.0.1", port: 0, allowedLogin: OPERATOR, allowedNodes: [NODE_PHONE], selfNodeId: NODE_SELF, whois, state: center.state, act: center.act };
	const handler = createCommandCenterHandler(listener, { isOff: () => false, refusal: (_args, reason) => void refusals.push(reason), audit: () => {} });
	let port = 0;
	const server: Server = createHttpServer((req, res) => void handler(req, res, port));
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
	port = (server.address() as AddressInfo).port;
	try {
		await run(port, refusals);
	} finally {
		// Node's shared agent keeps sockets alive, and a server waiting on them never closes.
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
	}
}

test("MG7: the state says when the view may have the message text, and a listener without the messages port says it may not", async () => {
	const without = await commandCenter(deps()).state();
	assert.equal(without.countsOnly, true, "no messages port: the view is counts only, so the page never asks for a route this listener does not serve");
	assert.equal(without.panels.messages, undefined, "and there is no messages panel to show");
	const withPort = await commandCenter(deps({ messages: { counts: () => ({ draftsWaiting: 2, needYou: 1 }) } as unknown as MessagesPort })).state();
	assert.equal(withPort.countsOnly, false, "a listener that serves `/cc/api/messages` says the view is not counts only");
	assert.equal(withPort.panels.messages.data?.counts.draftsWaiting, 2, "and its panel carries the counts it may show");
});

// ── Acceptance 2: the page and the CSP ─────────────────────────────────────

test("the page is served under D6's CSP and names no origin outside the gateway", async () => {
	await withListener(async (port) => {
		const page = await request(port, "/cc/");
		assert.equal(page.status, 200);
		assert.match(page.headers["content-type"] ?? "", /text\/html/);
		const csp = page.headers["content-security-policy"] ?? "";
		// D35's policy, directive by directive: no origin outside this listener, one nonce'd script, the page's own
		// inline style and the library's stylesheets from this listener, the system type. Nothing added, nothing widened.
		const directives = csp.split("; ");
		assert.equal(directives.length, 8, `the eight directives D35 names, found ${csp}`);
		assert.equal(directives[0], "default-src 'none'");
		const scriptSrc = /^script-src 'nonce-([A-Za-z0-9+/=]+)'$/.exec(directives[1] ?? "");
		assert.ok(scriptSrc !== null, `script-src is the load's nonce alone, found ${directives[1]}`);
		assert.deepEqual(directives.slice(2), ["style-src 'self' 'unsafe-inline'", "font-src 'self'", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"], csp);
		const nonce = scriptSrc![1];
		assert.ok(nonce !== undefined && nonce.length > 0, "the policy carries a nonce");
		// The one script carries that nonce, and the page carries the load's CSRF token.
		assert.equal(page.text.split("<script").length - 1, 1, "one script");
		// D35: the one script is a module carrying the nonce, and its static imports inherit that nonce, so the
		// library loads without widening script-src.
		assert.ok(page.text.includes(`<script type="module" nonce="${nonce}">`), "the script is a module carrying the nonce");
		assert.match(PAGE, /import "\/cc\/assets\/ui\/index\.js";/, "the page imports the vendored library");
		assert.match(page.text, /name="cc-csrf" content="[0-9a-f]{32}\.[0-9a-f]{64}"/);

		// No outside origin: the only absolute URL in the page is the SVG namespace, which is an identifier.
		const urls = [...PAGE.matchAll(/https?:\/\/[^\s"'()<]+/g)].map((match) => match[0]);
		assert.deepEqual([...new Set(urls)], ["http://www.w3.org/2000/svg"], `the page names no outside origin, found ${JSON.stringify(urls)}`);
		assert.doesNotMatch(PAGE, /src="\/\/|href="\/\/|@import|url\(\s*['"]?https?:/i);

		// Every asset it names is on the served list, and nothing else is. D37 leaves the page naming none until CRW
		// loads the library, so this is the membership rule alone, and it holds before and after that rewrite.
		const named = [...new Set([...PAGE.matchAll(/\/cc\/assets\/([A-Za-z0-9._\/-]+)/g)].map((match) => match[1]!))];
		for (const name of named) assert.ok(CC_ASSETS.has(name), `${name} is a served asset`);
	});

	// The page file itself carries no inline event handler, so a foreign origin has nothing to hook.
	assert.doesNotMatch(PAGE, /\son(click|load|error)=/i);
});

// ── Acceptance 3: the assets route ────────────────────────────────────────

test("every listed asset is served with its type, and no other name is", async () => {
	await withListener(async (port) => {
		for (const [name, type] of CC_ASSETS) {
			const reply = await request(port, `${CC_ASSETS_PATH}${name}`);
			assert.equal(reply.status, 200, name);
			assert.equal(reply.headers["content-type"], type, name);
			assert.ok(reply.text.length > 0, name);
		}
	});

	// CRV 1: the exact-name guard, with the library's own subdirectory names in the list. A dot segment, an
	// encoded slash, a name that is not listed and a listed name with a suffix or a trailing path all stay unlisted.
	const refused = ["unknown.js", "..", "../command-center-page.html", "..%2Fcommand-center-page.html", "%2e%2e%2fcommand-center-page.html", "ui/index.js/../../package.json", "ui%2Findex.js", "ui/../command-center.ts", "ui/index.js%00.png", "ui/nothing.js", "ui", "ui/", "", ".", "README.md%00.png"];
	await withListener(async (port, refusals) => {
		for (const name of refused) {
			const reply = await request(port, `${CC_ASSETS_PATH}${name}`);
			assert.equal(reply.status, 404, `"${name}" is refused`);
			assert.equal(reply.text, '{"error":"not found"}', `"${name}" leaks nothing`);
		}
		assert.ok(refusals.length >= refused.length, "every refusal is logged");
	});
});

test("an asset request passes the login and node checks like every other path", async () => {
	const asset = `${CC_ASSETS_PATH}ui/index.js`;
	// A login that is not the operator's.
	await withListener(async (port) => {
		assert.equal((await request(port, asset)).status, 403);
	}, async () => ({ login: "someone@example.test", nodeId: NODE_PHONE }));
	// The gateway's own node, whatever the list says.
	await withListener(async (port) => {
		assert.equal((await request(port, asset)).status, 403);
	}, async () => ({ login: OPERATOR, nodeId: NODE_SELF }));
	// A node under the operator's login that is not listed.
	await withListener(async (port) => {
		assert.equal((await request(port, asset)).status, 403);
	}, async () => ({ login: OPERATOR, nodeId: "node-unlisted" }));
	// tailscaled cannot name the peer.
	await withListener(async (port) => {
		assert.equal((await request(port, asset)).status, 403);
	}, async () => undefined);
});

// ── The ask kinds, and CRW 6: no stage word, no colour map, no model name ──

const askKindLabels = ((): string[] => {
	const block = /const KIND_LABELS = \{([\s\S]*?)\n\};/.exec(PAGE)?.[1];
	assert.ok(block !== undefined, "the page declares its kind labels");
	return [...block!.matchAll(/(?:"([a-z-]+)"|([a-z-]+)):\s*"/g)].map((match) => (match[1] ?? match[2])!);
})();

test("the page labels exactly the ask kinds the queue owns", () => {
	assert.deepEqual(askKindLabels.sort(), [...ASK_KINDS].sort(), "every ASK_KINDS key, and no other");
});

const UI_DIR_TOKENS = join(HERE, "..", "gateway", "cc-assets", "ui", "tokens.css");
const TOKENS = readFileSync(UI_DIR_TOKENS, "utf8");

const luminance = (hex: string): number => {
	const value = hex.replace("#", "");
	const channels = [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16) / 255).map((channel) => (channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)));
	return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
};
const contrast = (a: string, b: string): number => {
	const [high, low] = [luminance(a), luminance(b)].sort((left, right) => right - left);
	return (high! + 0.05) / (low! + 0.05);
};
const AA = 4.5;

/** The custom properties one theme block of the vendored tokens declares. */
function tokenBlock(pattern: RegExp): Record<string, string> {
	const block = pattern.exec(TOKENS)?.[1];
	assert.ok(block !== undefined, `the token block ${String(pattern)}`);
	const found: Record<string, string> = {};
	for (const match of block!.matchAll(/(--[a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})/g)) found[match[1]!] = match[2]!;
	return found;
}

test("CRW 6: the goal tints are the library's tokens, one pair per registry colour, each readable", () => {
	// D29: the library owns the swatch and the text-safe value, per theme. A colour added to the registry fails
	// here until the vendored tokens paint it.
	for (const [theme, pattern] of [["dark", /^:root \{([\s\S]*?)\n\}/m], ["light", /^:root\[data-theme="light"\] \{([\s\S]*?)\n\}/m]] as const) {
		const tokens = tokenBlock(pattern as RegExp);
		assert.match(tokens["--ground-2"] ?? "", /^#[0-9A-Fa-f]{6}$/, `the ${theme} surface`);
		for (const key of GOAL_COLOURS) {
			assert.match(tokens[`--tint-${key}`] ?? "", /^#[0-9A-Fa-f]{6}$/, `${theme} --tint-${key}`);
			assert.match(tokens[`--tint-${key}-text`] ?? "", /^#[0-9A-Fa-f]{6}$/, `${theme} --tint-${key}-text`);
			const ratio = contrast(tokens[`--tint-${key}-text`]!, tokens["--ground-2"]!);
			assert.ok(ratio >= AA, `${theme} ${key} text on the surface is ${ratio.toFixed(2)}:1`);
		}
	}
	assert.equal((GOAL_COLOURS as readonly string[]).includes("red"), false, "red is never a goal colour");
	// The page names no colour of its own: every tint reaches the DOM as a token.
	assert.deepEqual([...PAGE.matchAll(/#[0-9A-Fa-f]{6}\b/g)].map((match) => match[0]), [], "the page carries no hex colour");
	assert.match(PAGE, /--tint-/, "the tints are the library's variables");
});

test("CRW 6: the page holds no stage word and no model name", () => {
	// The stage vocabulary is the stage owner's: the page reads `state.stages` and never writes a key of it.
	for (const stage of LANE_STAGES) {
		// A one-word key is also ordinary English, so the rule is the key's own position: no object key, no lookup.
		assert.equal(new RegExp(`["']${stage}["']\\s*:`).test(PAGE), false, `no "${stage}" key in the page`);
		if (stage.includes("-")) assert.equal(PAGE.includes(`"${stage}"`) || PAGE.includes(`'${stage}'`), false, `no "${stage}" literal in the page`);
	}
	assert.match(PAGE, /stateStages\(\)/, "the page reads the stage list the state carries");
	assert.match(PAGE, /stage\.label/, "a column's name is the label the state names");
	// Model and provider names come from the gateway: the page prints `modelName` and maps none itself.
	assert.match(PAGE, /modelName/, "the page prints the name the row carries");
	for (const label of Object.values(PROVIDER_LABELS)) {
		assert.equal(PAGE.includes(label), false, `no provider name ("${label}") in the page`);
	}
});

// ── Acceptance 5, static half: the page never parses text into markup ─────

test("the page builds every node itself: no HTML string is ever parsed", () => {
	for (const forbidden of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "createContextualFragment", "new Function", "eval("]) {
		assert.equal(PAGE.includes(forbidden), false, `the page does not use ${forbidden}`);
	}
	// The one place text reaches the DOM is textContent, and the one place a style is set takes the page's own value.
	assert.ok(PAGE.includes("textContent"), "text is set as text");
	assert.match(PAGE, /function tintOf\(code\)/, "a tint is a token key the registry carries");
});

test("the states R5.1 names are copy the page actually carries", () => {
	for (const copy of ["Nothing waits on you.", "No goals yet. Goals start with the architect.", "Nothing shipped yet today.", "Nothing scheduled.", "Not held", "Can't reach the gateway", "The gateway restarted. Reload for the current state.", "Answer it on its card.", "Lanes with no goal", "Reading the gateway…"]) {
		assert.ok(PAGE.includes(copy), copy);
	}
	// D7: a stalled or leftover lane is the attention tone, never red.
	assert.match(PAGE, /row\.tone|tone: "attention"|attention/);
	// D7: a lane's own state tones it, and only as attention; the PC row is the one thing that may read red.
	const laneCard = /function laneCardData\(row\) \{([\s\S]*?)\n\}/.exec(PAGE)?.[1];
	assert.ok(laneCard !== undefined, "the lane card mapping is on the page");
	assert.equal(laneCard!.includes("red"), false, "a lane card is never red");
	assert.match(PAGE, /row\.tone === "attention"/, "a lane's own state is what tones it");
	assert.ok(STALE_ASK_MS === 2 * 24 * 60 * 60 * 1000, "the ticket age threshold is the composer's own");
});

test("the page file the handler reads is the one on disk", () => {
	assert.ok(existsSync(PAGE_FILE));
	assert.ok(PAGE.includes("__CC_CSRF__") && PAGE.includes("__CC_NONCE__"), "the placeholders the handler fills");
});

// ── CRV 1 and 2: the vendored library, and the fonts D37 removes ─────────

const ASSETS_DIR = join(HERE, "..", "gateway", "cc-assets");
const UI_DIR = join(ASSETS_DIR, "ui");
const MANIFEST_FILE = join(UI_DIR, "manifest.json");
const VERSION_FILE = join(UI_DIR, "VERSION");
const VENDOR_SCRIPT = join(piAgentDir(), "scripts", "vendor-graphite-ui.sh");

type VendoredManifest = { tag: string; commit: string; files: { file: string; type: string }[] };

function vendored(): VendoredManifest {
	assert.ok(existsSync(MANIFEST_FILE), "the vendored copy carries a manifest");
	return JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) as VendoredManifest;
}

/** Every file under `cc-assets/ui/`, relative to it, deepest last and in a stable order. */
function uiFiles(dir = UI_DIR): string[] {
	return readdirSync(dir, { withFileTypes: true })
		.flatMap((entry) => (entry.isDirectory() ? uiFiles(join(dir, entry.name)).map((name) => `${entry.name}/${name}`) : [entry.name]))
		.sort();
}

test("the vendored copy is the tag its VERSION names, and its manifest is the files on disk", () => {
	const manifest = vendored();
	assert.equal(manifest.tag, "v0.1.0", "the tag CRU approved (D35)");
	assert.match(manifest.commit, /^[0-9a-f]{40}$/, "the tag's own commit");
	assert.equal(readFileSync(VERSION_FILE, "utf8").trim(), `${manifest.tag} ${manifest.commit}`, "VERSION is the tag and its commit");
	// VERSION and the manifest are the copy's metadata, not assets the page may ask for.
	assert.deepEqual(uiFiles().filter((name) => name !== "VERSION" && name !== "manifest.json"), manifest.files.map((entry) => entry.file).sort(), "the manifest lists every vendored file, and only those");
	assert.deepEqual([...CC_ASSETS.keys()], ["README.md", ...manifest.files.map((entry) => `ui/${entry.file}`)], "the served list is the README plus the manifest's entries under ui/");
	// The library the page loads: its module, its two stylesheets and its elements, each with the type it is served as.
	for (const [file, type] of [["index.js", "text/javascript"], ["tokens.css", "text/css"], ["components.css", "text/css"]] as const) {
		assert.ok(manifest.files.some((entry) => entry.file === file && entry.type.startsWith(type)), `${file} is served as ${type}`);
	}
	assert.ok(manifest.files.some((entry) => entry.file.startsWith("elements/") && entry.file.endsWith(".js")), "the elements are vendored");
	for (const entry of manifest.files) assert.ok(readFileSync(join(UI_DIR, entry.file)).byteLength > 0, `${entry.file} is not empty`);
});

test("the vendored files are served under ui/ with the manifest's type, and the fonts are gone", async () => {
	const manifest = vendored();
	await withListener(async (port) => {
		for (const entry of manifest.files) {
			const reply = await request(port, `${CC_ASSETS_PATH}ui/${entry.file}`);
			assert.equal(reply.status, 200, entry.file);
			assert.equal(reply.headers["content-type"], entry.type, entry.file);
		}
		// CRV 2: the vendored fonts, their licences and their entries went with D37, so nothing asks for them.
		for (const name of ["onest-latin.woff2", "unbounded-cyrillic.woff2", "jetbrainsmono-latin.woff2", "OFL-onest.txt"]) {
			assert.equal((await request(port, `${CC_ASSETS_PATH}${name}`)).status, 404, name);
			assert.equal(CC_ASSETS.has(name), false, `${name} is no longer served`);
		}
	});
	for (const name of readdirSync(ASSETS_DIR)) assert.doesNotMatch(name, /\.woff2$|^OFL-/, `${name} went with D37`);
	assert.equal(/@font-face/.test(PAGE), false, "the page names no font file");
});

test("the vendor script copies a tag's files into cc-assets/ui/ and writes VERSION and manifest.json", () => {
	const scratch = mkdtempSync(join(tmpdir(), "crv-vendor-"));
	const library = join(scratch, "graphite-ui");
	const checkout = join(scratch, "repo");
	const vendoredUi = join(checkout, "packages", "muster", "gateway", "cc-assets", "ui");
	mkdirSync(join(checkout, "scripts"), { recursive: true });
	mkdirSync(join(checkout, "packages", "muster", "gateway", "cc-assets"), { recursive: true });
	cpSync(VENDOR_SCRIPT, join(checkout, "scripts", "vendor-graphite-ui.sh"));
	// A library shaped like the real one: a package.json naming what it ships, and files it does not ship.
	mkdirSync(join(library, "elements"), { recursive: true });
	mkdirSync(join(library, "test"), { recursive: true });
	writeFileSync(join(library, "package.json"), JSON.stringify({ name: "graphite-ui", version: "0.1.0", type: "module", files: ["index.js", "motion.js", "tokens.css", "components.css", "elements/"] }, null, "\t"));
	writeFileSync(join(library, "index.js"), "export const library = \"crv\";\n");
	writeFileSync(join(library, "motion.js"), "export const motion = \"crv\";\n");
	writeFileSync(join(library, "tokens.css"), ":root{--font:system-ui}\n");
	writeFileSync(join(library, "components.css"), ".panel{color:inherit}\n");
	writeFileSync(join(library, "elements", "g-kpi.js"), "customElements.define(\"g-kpi\", class extends HTMLElement {});\n");
	writeFileSync(join(library, "README.md"), "not shipped\n");
	writeFileSync(join(library, "test", "elements.test.js"), "not shipped\n");
	const git = (...args: string[]): ReturnType<typeof spawnSync> => spawnSync("git", ["-C", library, ...args], { encoding: "utf8" });
	assert.equal(git("init", "--quiet").status, 0);
	assert.equal(git("add", "-A").status, 0);
	assert.equal(git("-c", "user.name=CRV", "-c", "user.email=crv@example.test", "commit", "--quiet", "-m", "the library").status, 0);
	assert.equal(git("tag", "v0.1.0").status, 0);
	const commit = String(git("rev-parse", "HEAD").stdout).trim();
	// The working tree drifts from the tag: the copy must hold the tag's bytes, never the tree's.
	writeFileSync(join(library, "index.js"), "export const library = \"uncommitted\";\n");
	const script = join(checkout, "scripts", "vendor-graphite-ui.sh");
	const run = spawnSync("bash", [script, "v0.1.0"], { encoding: "utf8", env: { ...process.env, GRAPHITE_UI_REPO: library } });
	assert.equal(run.status, 0, run.stderr);
	assert.equal(readFileSync(join(vendoredUi, "VERSION"), "utf8").trim(), `v0.1.0 ${commit}`);
	const manifest = JSON.parse(readFileSync(join(vendoredUi, "manifest.json"), "utf8")) as VendoredManifest;
	assert.equal(manifest.tag, "v0.1.0");
	assert.equal(manifest.commit, commit);
	assert.deepEqual(manifest.files.map((entry) => entry.file), ["components.css", "elements/g-kpi.js", "index.js", "motion.js", "tokens.css"]);
	assert.equal(readFileSync(join(vendoredUi, "index.js"), "utf8"), "export const library = \"crv\";\n", "the tag's bytes, not the working tree's");
	for (const entry of manifest.files) assert.equal(readFileSync(join(vendoredUi, entry.file), "utf8"), String(git("show", `v0.1.0:${entry.file}`).stdout), entry.file);
	// Nothing the library does not ship arrives beside it.
	assert.equal(existsSync(join(vendoredUi, "README.md")), false);
	assert.equal(existsSync(join(vendoredUi, "test")), false);
	assert.equal(existsSync(join(vendoredUi, "package.json")), false);
	// A tag the library does not have is refused before anything is written.
	const refused = spawnSync("bash", [script, "v9.9.9"], { encoding: "utf8", env: { ...process.env, GRAPHITE_UI_REPO: library } });
	assert.notEqual(refused.status, 0, "an unknown tag is refused");
	assert.equal(existsSync(join(vendoredUi, "index.js")), true, "the refused run left the copy as it was");
});
