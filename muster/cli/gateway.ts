/**
 * `muster gateway` — the Grokbot gateway (an MCP server on 127.0.0.1) and its
 * off switch. See gateway/server.ts for what it serves and refuses.
 */

import { homedir } from "node:os";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { enumerateLanes } from "../lib/lane-directory.ts";
import { readLaneCard } from "../lib/lane-card.ts";
import { enqueueLaneControl } from "../lib/lane-control.ts";
import { ConcordClient } from "../concord.ts";
import { musterStateDir, piAgentDir } from "../binding.ts";
import { checkoutHead, writeGatewayCode } from "../gateway-code.ts";
import { goalStore, listGoals } from "../goals.ts";
import { catalogueRepos, readProjectCatalogue } from "../projects.ts";
import { startGateway, type RunningGateway } from "../gateway/server.ts";
import { createPendingStore, PENDING_FILE } from "../gateway/command-center-pending.ts";
import type { LoopbackListener } from "../gateway/command-center-local.ts";
import { ledgerWakeSource, type LiveWake } from "../gateway/command-center-live.ts";
import { renewCertificate, tlsFilesIn, tlsFilesPresent } from "../gateway/command-center-tls.ts";
import { CC_AGENT_ID, commandCenter, commandCenterScripts, gateStatusReader, heavyJobsRunner, pageMessageSender, psiKillReader, readTailnetSelf, tailscaleWhois, type CommandCenterListener } from "../gateway/command-center.ts";
import { readAsks } from "../asks.ts";
import { messagingRoot } from "../messaging/archive.ts";
import { chatTextSessionWithheld } from "../messaging/chat-sessions.ts";
import { headlessDraftWriter, type DraftWriter } from "../messaging/drafts.ts";
import { messagesPort } from "../messaging/page.ts";
import { openMessagingStore } from "../messaging/store.ts";
import { systemTimersReader } from "../gateway/command-center-panels.ts";
import { LANE_HISTORY_LIMIT_MAX, laneHistoryEntries } from "../gateway/lane-history.ts";
import { readLogTailLines } from "../gateway/logs.ts";
import { runAsReader } from "../gateway/dashboard-login.ts";
import { defaultGitRepos, defaultInstructionsRoots, defaultMemoryRoots, defaultPlanRoots, defaultProjectRoots, defaultReportsRoot, defaultSkillRoots, memoryRecall } from "../gateway/knowledge.ts";
import { piPort } from "../../core/pi-ports.ts";
import { createPowerTools } from "../gateway/power-tools.ts";
import { deskDelivery } from "../gateway/desk-delivery.ts";
import { ARCHITECT_ADDRESS, createGatewayTools, inboxSender, uploadDelivery, type ActionToolDeps, type GatewayToolDeps } from "../gateway/tools.ts";
import { opencodeModelsReader, readPiSettingsModels } from "../gateway/catalog.ts";
import { runLaunchScript } from "../gateway/launch.ts";
import { closeLaneLive } from "../lane-lifecycle-ports.ts";
import { execCaptured, gatewayLaneSend } from "../send-deps.ts";
import type { SendRequest } from "../send.ts";
import {
	AUDIT_FILE,
	GATEWAY_AGENT_ID,
	gatewayStateDir,
	gatewayStatus,
	gatewayTokenFile,
	initGatewayToken,
	isGatewayOff,
	readGatewayToken,
	readMonitorToken,
	removeGatewayPid,
	turnGatewayOff,
	turnGatewayOn,
	writeGatewayPid,
} from "../gateway/state.ts";
import { ORCHESTRATOR_ADDRESS, orchestratorEventsPath } from "../lane-report.ts";
import { lanesCardsDir, lanesRegistryPath } from "./lanes.ts";
import { parseFlags, type CliCommand } from "./types.ts";

const DEFAULT_PORT = 47420;
/** The command center listener's port (CC_PORT); it binds the PC's tailnet address only. */
const DEFAULT_CC_PORT = 47421;

/**
 * The launcher moved with muster (OL12-D8): it sits in this package's own
 * `scripts/` folder, found beside this file rather than through the Pi profile
 * (S10's own-package rule).
 */
const LAUNCH_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "pi-lane-launch.sh");

/**
 * MG7: the writer a redraft asks and the model the pool's `reply` role names, resolved when the operator taps
 * Draft again. Without a `reply` role there is no redraft: the action answers 503 rather than guessing a
 * model. The same rule and the same reader as `scripts/messaging-draft.mts`.
 */
async function messagingDrafting(): Promise<{ writer: DraftWriter; model: string } | undefined> {
	const { loadPoolConfig } = await import("../../routing/provider-pool.ts");
	const pinned = (process.env["PI_PROVIDER_POOL_PATH"] ?? "").trim();
	const loaded = loadPoolConfig(pinned === "" ? join(piAgentDir(), "provider-pool.json") : pinned);
	if (!loaded.ok) return undefined;
	const model = loaded.config.roles["reply"]?.[0];
	if (model === undefined) return undefined;
	return { writer: headlessDraftWriter(), model };
}

export const command: CliCommand = {
	name: "gateway",
	summary: "The Grokbot gateway: MCP over HTTP on 127.0.0.1 (optionally one public host behind a tunnel) with a bearer token, an audit log and an off switch",
	usage: [
		"muster gateway serve [--port <n>] [--public-host <name>]   # foreground; refuses to start while the gateway is off",
		"muster gateway off                       # stops the server and refuses every call until `on`",
		"muster gateway on",
		"muster gateway status [--json]",
		"muster gateway init-token                # creates the token file (0600) outside the repo; never prints it",
		"  monitor bearer: GROKBOT_MONITOR_TOKEN (optional; the monitor bot's own connection, the only one that lists dashboard_login; unset means that tool is served to no one)",
		"muster gateway cert-renew                # renews the command center's HTTPS certificate (tailscale cert) into the state dir and tells the running gateway to reload it; exit 3 when the tailnet has HTTPS off",
		"  command center, PC view: CC_LOCAL_PORT (a port on 127.0.0.1 only; unset means no such listener) serves the same page and read routes with no action; an action posted there waits for the operator's tap on the phone",
		"  command center: CC_ALLOWED_LOGIN (the one tailnet login that may open /cc/) and CC_ALLOWED_NODES (comma-separated stable node ids of the machines that may; this PC's own node is always refused); either unset means no listener; on CC_PORT (default 47421) at this PC's tailnet address, read from tailscaled; never 127.0.0.1:47420 or a wildcard",
		"  public host: GROKBOT_GATEWAY_PUBLIC_HOST (a bare name such as bot.example.com that a tunnel on this machine forwards; nothing else is bound but 127.0.0.1)",
		"  state dir: GROKBOT_GATEWAY_STATE_DIR (default ~/.pi/state/grokbot-gateway); token file: GROKBOT_GATEWAY_TOKEN_FILE (default ~/.config/grokbot-gateway/token)",
	].join("\n"),
	async run(ctx) {
		const parsed = parseFlags(ctx.argv, ["port", "public-host"]);
		const sub = parsed.positionals[0];
		const stateDir = gatewayStateDir(ctx.env);
		switch (sub) {
			case "off": {
				const { stoppedPid } = turnGatewayOff(stateDir);
				ctx.io.out(`gateway: off${stoppedPid !== undefined ? `; stopped pid ${stoppedPid}` : "; no running server found"}. Calls are refused until: muster gateway on`);
				return 0;
			}
			case "on": {
				turnGatewayOn(stateDir);
				ctx.io.out("gateway: on (start it with: muster gateway serve)");
				return 0;
			}
			case "status": {
				const status = gatewayStatus(stateDir);
				ctx.io.out(ctx.json ? JSON.stringify(status) : `gateway: ${status.off ? "off" : "on"}, ${status.running ? `running (pid ${status.pid})` : "not running"}`);
				return 0;
			}
			case "init-token": {
				try {
					ctx.io.out(`gateway: token file created at ${initGatewayToken(gatewayTokenFile(ctx.env))} (not printed)`);
					return 0;
				} catch (error) {
					ctx.io.err(`muster gateway: ${(error as NodeJS.ErrnoException).code === "EEXIST" ? "a token file already exists; it is not overwritten" : error instanceof Error ? error.message : String(error)}`);
					return 1;
				}
			}
			case "cert-renew": {
				const self = await readTailnetSelf();
				if (self?.dnsName === undefined) {
					ctx.io.err("muster gateway cert-renew: tailscaled gave no MagicDNS name for this machine");
					return 1;
				}
				const outcome = await renewCertificate({ dnsName: self.dnsName, files: tlsFilesIn(stateDir) });
				if (!outcome.ok) {
					ctx.io.err(`muster gateway cert-renew: ${outcome.blocked ? "BLOCKED: " : ""}${outcome.detail}`);
					return outcome.blocked ? 3 : 1;
				}
				ctx.io.out(`gateway: certificate for ${self.dnsName} valid until ${outcome.notAfter}; ${outcome.detail}`);
				return 0;
			}
			case "serve": {
				if (isGatewayOff(stateDir)) {
					ctx.io.err("muster gateway: the gateway is off; run `muster gateway on` first");
					return 1;
				}
				let token: string;
				let monitorToken: string | undefined;
				try {
					token = readGatewayToken(gatewayTokenFile(ctx.env));
					monitorToken = readMonitorToken();
				} catch (error) {
					ctx.io.err(`muster gateway: ${error instanceof Error ? error.message : String(error)}`);
					return 1;
				}
				const port = Number(parsed.values.get("port") ?? ctx.env["GROKBOT_GATEWAY_PORT"] ?? DEFAULT_PORT);
				if (!Number.isInteger(port) || port < 1 || port > 65535) {
					ctx.io.err("muster gateway: --port must be 1-65535");
					return 2;
				}
				const publicHost = (parsed.values.get("public-host") ?? ctx.env["GROKBOT_GATEWAY_PUBLIC_HOST"] ?? "").trim() || undefined;
				const muster = musterStateDir();
				const home = ctx.env["HOME"] ?? homedir();
				const notesRoot = ctx.env["GROKBOT_GATEWAY_NOTES_ROOT"]?.trim() || join(home, ".pi", "agent", "plans", "orchestration-2026-10-05", "handoffs", "lane-state");
				const handoffsMsgsDir = join(home, ".pi", "agent", "plans", "orchestration-2026-10-05", "handoffs", "msgs");
				// Each action tool calls the existing bus owner; none re-implements a verb. The Concord
				// client is opened per send and closed again, the same path `muster send` takes.
				const actions: ActionToolDeps = {
					home,
					handoffsMsgsDir,
					// The catalogs `lane_launch` and `lane_control set-model` validate against: OpenCode's own
					// model list (cached) and the models Pi's settings enable, next to the provider pool.
					opencodeModelsOutput: opencodeModelsReader({ run: execCaptured, bin: ctx.env["OPENCODE_BIN"]?.trim() || "opencode" }),
					piSettingsModels: () => readPiSettingsModels(join(home, ".pi", "agent", "settings.json")),
					deliverLaneMessage: (request) =>
						gatewayLaneSend(request as SendRequest, muster, async (repoRoot) => {
							const client = await ConcordClient.connect({ launcherMcp: join(piAgentDir(), "extensions", "muster", "launchers", "concord-mcp"), repoRoot: repoRoot ?? ctx.repoRoot, agentId: GATEWAY_AGENT_ID, cwd: ctx.cwd });
							return { callTool: (name, args, options) => client.callTool(name, args, options), close: () => client.close() };
						}, { senderRoot: ctx.repoRoot }),
					readLaneCard: (sd, laneId) => readLaneCard(sd, laneId),
					enqueueLaneControl: (sd, request) => enqueueLaneControl(sd, request),
					closeLane: async (laneId, caller) => {
						const closed = await closeLaneLive(muster, laneId, { park: false, terminal: { outcome: "abandoned", reason: `stopped by ${caller}` }, caller });
						return { ok: closed.ok, detail: closed.detail };
					},
					launchLane: ({ lane, harness, cwd, brief, model, title }) => runLaunchScript(LAUNCH_SCRIPT, ["--lane", lane, "--harness", harness, "--cwd", cwd, "--brief", brief, "--model", model, "--title", title, "--no-attach", "--launched-by", "grokbot"]),
					readLaneLatestReport: (sd, laneId) => { const mark = readLaneCard(sd, laneId)?.lastReport; return mark === undefined ? undefined : { kind: mark.kind, text: mark.summary }; },
					canWriteBrief: (name, content) => {
						if (!/^[a-z0-9-]+\.md$/.test(name)) return { ok: false, reason: "name must match /^[a-z0-9-]+\\.md$/" };
						if (Buffer.byteLength(content, "utf8") > 64 * 1024) return { ok: false, reason: "content is longer than 65536 bytes" };
						const path = join(handoffsMsgsDir, name);
						if (existsSync(path)) return { ok: false, reason: `would overwrite ${path}` };
						mkdirSync(handoffsMsgsDir, { recursive: true, mode: 0o700 });
						writeFileSync(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
						return { ok: true, path };
					},
				};
				const laneDirectory = () => enumerateLanes({ laneCardsDir: lanesCardsDir(ctx.env), laneRegistryPath: lanesRegistryPath(ctx.env) });
				const toolDeps: GatewayToolDeps = {
					stateDir: muster,
					lanes: laneDirectory,
					// Session oversight (the operator 2026-10-16 14:42/14:43): the register is the catalogue reader
					// (projects.ts); a missing or unreadable catalogue means no register, never a crash.
					oversight: {
						home,
						stateDir: muster,
						lanes: laneDirectory,
						register: () => {
							try {
								return readProjectCatalogue();
							} catch {
								return undefined;
							}
						},
					},
					notesRoot,
					agentId: GATEWAY_AGENT_ID,
					gatewayStateDir: stateDir,
					...(publicHost !== undefined ? { publicHost } : {}),
					knowledge: {
						wikiRoot: join(home, "knowledge", "wiki"),
						planRoots: defaultPlanRoots(home),
						gitRepos: defaultGitRepos(home),
						skillRoots: defaultSkillRoots(home),
						projectRoots: defaultProjectRoots(home),
						graphRepos: () => { try { return catalogueRepos(readProjectCatalogue()); } catch { return []; } },
						memoryRoots: defaultMemoryRoots(home),
						reportsRoot: defaultReportsRoot(home),
						instructionsRoots: defaultInstructionsRoots(home),
						recall: memoryRecall(ctx.env["GROKBOT_GATEWAY_RECALL_CWD"]?.trim() || home),
						historySearch: (params) => piPort("history").executeHistorySearch(params),
						historyRead: (params) => piPort("history").executeHistoryRead(params),
						home,
					},
					actions,
					// UM14: the dashboard logins are served only with a monitor bearer to serve them to.
					...(monitorToken !== undefined ? { dashboardLogin: { read: runAsReader({ bin: join(ctx.repoRoot, "scripts", "secrets", "infisical-agent") }) } } : {}),
					sendToOrchestrator: inboxSender({ stateDir: muster, agentId: GATEWAY_AGENT_ID, recipientId: ORCHESTRATOR_ADDRESS }),
					sendToArchitect: inboxSender({ stateDir: muster, agentId: GATEWAY_AGENT_ID, recipientId: ARCHITECT_ADDRESS }),
				};
				const tools = [...createGatewayTools(toolDeps), ...createPowerTools({ stateDir, home, agentDir: ctx.repoRoot })];
				// The command center (VR24-21): a second listener on the PC's tailnet address, only when the allowed login
				// and the address are both known. Without either it is not started, and the main listener is unaffected.
				// WP1c (VR24-74): a third listener on 127.0.0.1 at CC_LOCAL_PORT, only when that is set, serving the same
				// page and reads with no action. Both build the center once, and share one store of pending PC actions.
				let commandCenterListener: CommandCenterListener | undefined;
				let loopbackListener: LoopbackListener | undefined;
				const ccLogin = (ctx.env["CC_ALLOWED_LOGIN"] ?? "").trim();
				const ccPort = Number(ctx.env["CC_PORT"] ?? DEFAULT_CC_PORT);
				const ccNodes = (ctx.env["CC_ALLOWED_NODES"] ?? "").split(",").map((id) => id.trim()).filter((id) => id !== "");
				const localText = (ctx.env["CC_LOCAL_PORT"] ?? "").trim();
				const localPort = Number(localText);
				const wantLocal = localText !== "";
				const pending = createPendingStore({ file: join(stateDir, PENDING_FILE) });
				const buildCenter = () => {
					const scripts = commandCenterScripts(ctx.repoRoot);
					return commandCenter({
						stateDir: muster,
						home,
						lanes: laneDirectory,
						gateStatus: gateStatusReader(scripts.gate),
						psiKills: psiKillReader(orchestratorEventsPath(muster)),
						asks: () => readAsks(muster).asks,
						// D30: the live hub's wakes, from this process's ledger subscription while a page is connected.
						liveWakes: (onWake: (wake: LiveWake) => void) => ledgerWakeSource(muster, onWake),
						closeLane: actions.closeLane!,
						// An answered ask tells its raiser through the gateway's one send path: the seat's inbox only, never a wake.
						notifyRaiser: async (recipient, text) => void (await inboxSender({ stateDir: muster, agentId: CC_AGENT_ID, recipientId: recipient })(text)),
						heavyJobs: heavyJobsRunner(scripts.pause),
						// The message box (D4): the seats' inbox path and Henry's wake path, both sent as operator-page.
						sendMessage: pageMessageSender({ stateDir: muster }),
						// WPS: the composer panels. The goals come from the goal registry (WPG, D1): every goal, closed ones included (the shipped panel reads their events).
						goals: () => listGoals(goalStore(), { all: true }).goals,
						register: toolDeps.oversight?.register,
						laneHistory: () => laneHistoryEntries(toolDeps.oversight!, { limit: LANE_HISTORY_LIMIT_MAX }),
						timers: systemTimersReader(),
						auditLines: () => readLogTailLines(join(stateDir, AUDIT_FILE)),
						// NLP: the research desk's cards and taps (D13, D14), the same store Henry's card tools use; a tap reaches a seat through the inbox path.
						desk: muster,
						deliverCard: deskDelivery({ stateDir: muster }),
						pending,
						// MG6: the waiting drafts. The store is opened per call and only when its folder exists, so a machine without messaging gets zeros.
						// MG7: redraft resolves the pool's `reply` role and the headless writer when the operator asks, so a page load pays for neither.
						messages: messagesPort({
							open: () => (existsSync(messagingRoot()) ? openMessagingStore() : undefined),
							stateDir: muster,
							drafting: () => messagingDrafting(),
						}),
					});
				};
				let center: ReturnType<typeof buildCenter> | undefined;
				if (ccLogin === "") ctx.io.err("muster gateway: command center not started: CC_ALLOWED_LOGIN is not set");
				else if (ccNodes.length === 0) ctx.io.err("muster gateway: command center not started: CC_ALLOWED_NODES is not set");
				else if (!Number.isInteger(ccPort) || ccPort < 1 || ccPort > 65535 || ccPort === port) ctx.io.err("muster gateway: command center not started: CC_PORT must be 1-65535 and differ from the gateway port");
				else {
					const self = await readTailnetSelf();
					if (self === undefined) ctx.io.err("muster gateway: command center not started: tailscaled gave no tailnet address");
					else {
						center = buildCenter();
						// HTTPS when `cert-renew` has put a certificate in the state dir; plain HTTP until then.
						const tls = tlsFilesIn(stateDir);
						commandCenterListener = { host: self.address, port: ccPort, allowedLogin: ccLogin, allowedNodes: ccNodes, selfNodeId: self.nodeId, ...(self.dnsName !== undefined ? { allowedHosts: [self.dnsName] } : {}), whois: tailscaleWhois(), pending, live: center.live, ...(tlsFilesPresent(tls) ? { tls } : {}), state: center.state, act: center.act, feed: center.feed, report: center.report, ...(center.messages !== undefined ? { messages: center.messages } : {}), ...(center.messagesPanel !== undefined ? { messagesPanel: center.messagesPanel } : {}), ...(center.messagesThread !== undefined ? { messagesThread: center.messagesThread } : {}) };
					}
				}
				if (wantLocal) {
					if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535 || localPort === port || localPort === ccPort) ctx.io.err("muster gateway: PC view not started: CC_LOCAL_PORT must be 1-65535 and differ from the gateway port and CC_PORT");
					else {
						center ??= buildCenter();
						loopbackListener = { port: localPort, state: center.state, live: center.live, feed: center.feed, report: center.report, pending, feedWithheld: chatTextSessionWithheld(muster) };
					}
				}
				let gateway: RunningGateway;
				try {
					gateway = await startGateway({ stateDir, token, ...(monitorToken !== undefined ? { monitorToken } : {}), tools, port, publicHost, files: { musterStateDir: muster, deliver: uploadDelivery(toolDeps, actions) }, ...(commandCenterListener !== undefined ? { commandCenter: commandCenterListener } : {}), ...(loopbackListener !== undefined ? { commandCenterLocal: loopbackListener } : {}) });
				} catch (error) {
					ctx.io.err(`muster gateway: ${error instanceof Error ? error.message : String(error)}`);
					return 1;
				}
				if (gateway.commandCenterError !== undefined) ctx.io.err(`muster gateway: command center not started: ${gateway.commandCenterError}`);
				else if (gateway.commandCenter !== undefined) ctx.io.out(`gateway: command center on ${commandCenterListener?.tls !== undefined ? "https" : "http"}://${gateway.commandCenter.host}:${gateway.commandCenter.port}/cc/ (tailnet address only; the peer login is checked by tailscaled whois${commandCenterListener?.tls !== undefined ? "" : "; no certificate yet, run: muster gateway cert-renew"})`);
				if (gateway.commandCenterLocalError !== undefined) ctx.io.err(`muster gateway: PC view not started: ${gateway.commandCenterLocalError}`);
				else if (gateway.commandCenterLocal !== undefined) ctx.io.out(`gateway: PC view on http://localhost:${gateway.commandCenterLocal.port}/cc/ (127.0.0.1 only; reads only, an action waits for your tap on the phone)`);
				writeGatewayPid(stateDir, process.pid);
				// LD19: the commit this process runs, so the tick can tell when main has moved past it.
				const startedFrom = checkoutHead(piAgentDir());
				if (startedFrom !== undefined) writeGatewayCode(muster, { sha: startedFrom, startedAt: new Date().toISOString(), pid: process.pid });
				ctx.io.out(`gateway: listening on http://127.0.0.1:${gateway.port}/mcp (loopback only${publicHost !== undefined ? `; also accepts Host ${publicHost} for a tunnel on this machine` : ""}; audit log ${join(stateDir, "audit.jsonl")})`);
				await new Promise<void>((resolveStop) => {
					const stop = (): void => {
						removeGatewayPid(stateDir);
						void gateway.close().then(resolveStop);
					};
					// `cert-renew` signals a reload; without a handler SIGHUP would end the process.
					process.on("SIGHUP", () => {
						const reloaded = gateway.reloadTls();
						ctx.io.out(`gateway: ${reloaded.ok ? "" : "certificate not reloaded: "}${reloaded.detail}`);
					});
					process.once("SIGTERM", stop);
					process.once("SIGINT", stop);
				});
				return 0;
			}
			default:
				ctx.io.err("muster gateway: serve, off, on, status or init-token\n" + command.usage);
				return 2;
		}
	},
};
