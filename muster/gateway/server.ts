/**
 * The Grokbot gateway server: MCP over streamable HTTP, loopback only.
 *
 * Stateless: every request gets its own MCP server and transport. Order of
 * refusals, each one audited: not the MCP path, a foreign Host or an Origin
 * header (DNS rebinding), the off switch, the wrong method, the bearer token.
 * Nothing is bound but 127.0.0.1. A tunnel on this machine may reach it under
 * one configured public host (`publicHost`); any other Host is still refused.
 * A tool call is audited twice: an intent line before the tool runs (if it
 * cannot be written the tool does not run) and a result line after.
 *
 * The command center (`commandCenter`) is a second listener in this process, bound only to the
 * address it is given (the PC's tailnet address), serving only `/cc/` (command-center.ts), over HTTPS when it is
 * given a certificate. It never answers on the main loopback listener or the tunnel's host, and a refusal to start it
 * leaves the main listener up. `commandCenterLocal` is a third listener on 127.0.0.1 at its own port: the same page
 * and read routes, no action (command-center-local.ts). It is off unless it is given.
 */

import { createReadStream, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { isIP } from "node:net";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { redactSensitiveText } from "../../core/self-improving-redactor.ts";
import { AttachmentTooLarge, MAX_ATTACHMENT_BYTES, resolveAttachment, sanitizeAttachmentName, storeAttachment, type AttachmentRef } from "../lib/inbox-attachments.ts";
import { linkShortId, markSpent, MAX_GETS_PER_LINK, readLink, spendGet, sweepExpiredLinks } from "./file-links.ts";
import { createCommandCenterHandler, isWildcardOrUnnamed, type CommandCenterListener } from "./command-center.ts";
import { createLoopbackHandler, type LoopbackListener } from "./command-center-local.ts";
import { readTlsMaterial } from "./command-center-tls.ts";
import { appendAudit, auditArgs, bearerMatches, GATEWAY_AGENT_ID, isGatewayOff } from "./state.ts";
import { ToolRefusal, type GatewayTool } from "./tools.ts";

/** Which bearer a request carried: the chat bot's (`token`) or the monitor bot's (`monitorToken`). */
type BearerRole = "chat" | "monitor";

export const MCP_PATH = "/mcp";
export const FILES_PREFIX = "/files/";
/** `/files/` is reachable without the bearer token, so it has its own limits (F4). */
export const MAX_FILE_TRANSFERS = 2;
export const FILE_IDLE_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1024 * 1024;
/** Refusals of unauthenticated requests are logged up to this many per minute; a public address gets scanned. */
export const HTTP_REFUSALS_LOGGED_PER_MINUTE = 60;
const PUBLIC_HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** What `/files/` needs beyond the gateway's own state: the attachment store and the delivery of an upload. */
export type FileTransferOptions = {
	/** Muster state dir: the attachment store lives under it. */
	musterStateDir: string;
	/** Delivers a stored upload to its addressee. Not ok means the upload is kept but the link is not spent. */
	deliver: (upload: { to: string; note?: string; attachment: AttachmentRef }) => Promise<{ ok: boolean; detail: string }>;
	maxUploadBytes?: number;
	maxTransfers?: number;
	idleTimeoutMs?: number;
};

export type GatewayOptions = {
	stateDir: string;
	token: string;
	/**
	 * The monitor bot's own bearer (`GROKBOT_MONITOR_TOKEN`, UM14). Its tool list is the chat list plus the
	 * tools flagged `monitorOnly`, minus the tools flagged `chatOnly`. Absent means no such bearer exists, so a `monitorOnly` tool is served to no one.
	 */
	monitorToken?: string;
	tools: GatewayTool[];
	/** 0 picks a free port (tests). */
	port: number;
	/** One extra Host (a bare lowercase name, no scheme or port) that a tunnel on this machine forwards, such as bot.example.com. */
	publicHost?: string;
	/** Absent means `/files/` is not served. */
	files?: FileTransferOptions;
	/** Absent means no command center listener. */
	commandCenter?: CommandCenterListener;
	/** Absent means no loopback command center listener. */
	commandCenterLocal?: LoopbackListener;
	now?: () => Date;
};

export type RunningGateway = {
	server: HttpServer;
	port: number;
	close: () => Promise<void>;
	/** The command center listener's bound address and port, when it started. */
	commandCenter?: { server: HttpServer; host: string; port: number };
	/** Why the command center listener did not start; the main listener is up regardless. */
	commandCenterError?: string;
	/** The loopback command center listener's port, when it started. */
	commandCenterLocal?: { server: HttpServer; port: number };
	commandCenterLocalError?: string;
	/** Reads the certificate pair again for new tailnet handshakes; open connections are not touched. Not ok keeps the old pair. */
	reloadTls: () => { ok: boolean; detail: string };
};

function reply(res: ServerResponse, status: number, message: string): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: message }));
}

async function readBody(req: IncomingMessage): Promise<string | undefined> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) return undefined;
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export async function startGateway(options: GatewayOptions): Promise<RunningGateway> {
	const now = options.now ?? (() => new Date());
	const publicHost = options.publicHost?.trim().toLowerCase() || undefined;
	if (publicHost !== undefined && !PUBLIC_HOST.test(publicHost)) throw new Error(`public host must be a bare host name such as bot.example.com, got "${publicHost}"`);
	const audit = (tool: string, args: unknown, resultBytes: number | null, refused: boolean, reason?: string, phase?: "intent" | "result", role?: BearerRole): void => {
		try {
			appendAudit(options.stateDir, { at: now().toISOString(), tool, args: auditArgs(args), resultBytes, refused, ...(reason !== undefined ? { reason } : {}), ...(phase !== undefined ? { phase } : {}), ...(role !== undefined ? { role } : {}) });
		} catch {
			// A log that cannot be written must not become a way past the log: the call is refused below.
			throw new Error("audit log could not be written");
		}
	};
	if (options.monitorToken !== undefined && options.monitorToken === options.token) throw new Error("the monitor token must differ from the gateway token");
	// One tool list per bearer: the chat bearer never sees a `monitorOnly` tool, and with no monitor bearer nobody does.
	// The monitor bearer never sees a `chatOnly` tool.
	const toolsByRole: Record<BearerRole, Map<string, GatewayTool>> = {
		chat: new Map(options.tools.filter((tool) => tool.monitorOnly !== true).map((tool) => [tool.name, tool])),
		monitor: new Map(options.tools.filter((tool) => tool.chatOnly !== true).map((tool) => [tool.name, tool])),
	};
	const roleOf = (header: string | undefined): BearerRole | undefined => {
		if (bearerMatches(header, options.token)) return "chat";
		if (options.monitorToken !== undefined && bearerMatches(header, options.monitorToken)) return "monitor";
		return undefined;
	};

	function mcpServer(role: BearerRole): Server {
		const tools = toolsByRole[role];
		const server = new Server({ name: "grokbot-gateway", version: "1.0.0" }, { capabilities: { tools: {} } });
		server.setRequestHandler(ListToolsRequestSchema, async () => ({
			tools: [...tools.values()].map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
		}));
		server.setRequestHandler(CallToolRequestSchema, async (request) => {
			const name = request.params.name;
			const args = (request.params.arguments ?? {}) as Record<string, unknown>;
			const tool = tools.get(name);
			if (tool === undefined) {
				audit(name, args, null, true, options.tools.some((t) => t.name === name) ? "not in this bearer's tool list" : "unknown tool", undefined, role);
				return { isError: true, content: [{ type: "text" as const, text: `unknown tool ${name}` }] };
			}
			// Intent first: if the log cannot be written the tool does not run.
			audit(name, args, null, false, undefined, "intent", role);
			let text: string;
			let failure: { message: string; refused: boolean } | undefined;
			try {
				// Whatever a tool read, the text that leaves the machine goes through the
				// shared redactor: secret-looking assignments, keys, tokens and URIs.
				// A tool flagged `returnsCredential` (dashboard_login) is the one exception: its whole result
				// is the credential and redaction would mask an email-shaped username or a token-shaped password.
				const output = await tool.run(args, { role });
				text = tool.returnsCredential === true ? output : redactSensitiveText(output, { preservePaths: true, strictAssignments: true });
			} catch (error) {
				failure = { message: error instanceof ToolRefusal ? error.message : "the tool failed", refused: error instanceof ToolRefusal };
				text = failure.message;
			}
			try {
				audit(name, args, Buffer.byteLength(text), failure?.refused ?? false, failure === undefined ? undefined : failure.refused ? failure.message : "tool error", "result", role);
			} catch {
				// The intent line is on record; a tool that already ran (a send) is not reported as failed.
			}
			return failure === undefined ? { content: [{ type: "text" as const, text }] } : { isError: true, content: [{ type: "text" as const, text }] };
		});
		return server;
	}

	// Requests refused before a tool runs can come from anyone on the internet once a tunnel is up, so
	// the log keeps the first minute's worth and then one line saying how many were not written.
	let windowStart = 0;
	let windowLogged = 0;
	let windowDropped = 0;
	const auditHttpRefusal = (args: unknown, reason: string): void => {
		const at = now().getTime();
		if (at - windowStart >= 60_000) {
			if (windowDropped > 0) audit("(http)", {}, null, true, `${windowDropped} further refusals in the last minute were not logged`);
			windowStart = at;
			windowLogged = 0;
			windowDropped = 0;
		}
		if (windowLogged < HTTP_REFUSALS_LOGGED_PER_MINUTE) {
			windowLogged += 1;
			audit("(http)", args, null, true, reason);
		} else windowDropped += 1;
	};

	const http = createServer((req, res) => {
		void handle(req, res).catch(() => {
			if (!res.headersSent) reply(res, 500, "gateway error");
			else res.end();
		});
	});

	const hostAllowed = (host: string | undefined, port: number): boolean => host === `127.0.0.1:${port}` || host === `localhost:${port}` || (publicHost !== undefined && host?.toLowerCase() === publicHost);

	// The puts in flight, keyed by the link's hash: the check and the reservation are one synchronous step.
	const putsInFlight = new Set<string>();
	let transfers = 0;

	/**
	 * `/files/<token>[/<name>]`. The token is the capability. Order of refusals, each one audited under
	 * `/files/<first 8 hex of the token's hash>` and never under the URL: a Host that is not allowed, an
	 * Origin header, the off switch, an unknown or expired token, the wrong method, a used-up link, a
	 * put in flight, too many transfers.
	 */
	async function handleFile(req: IncomingMessage, res: ServerResponse, pathname: string, port: number, files: FileTransferOptions): Promise<void> {
		const [token = "", ...rest] = pathname.slice(FILES_PREFIX.length).split("/");
		const shortId = linkShortId(token);
		const refuse = (status: number, reason: string): void => {
			auditHttpRefusal({ method: req.method, path: `${FILES_PREFIX}${shortId}` }, reason);
			reply(res, status, reason);
		};
		if (!hostAllowed(req.headers.host, port)) return refuse(403, "host not allowed");
		if (req.headers.origin !== undefined) return refuse(403, "origin not allowed");
		if (isGatewayOff(options.stateDir)) return refuse(503, "gateway is off");
		const link = readLink(options.stateDir, token, now());
		if (link === undefined) return refuse(404, "not found");
		const { hash, record } = link;
		if (req.method !== (record.kind === "get" ? "GET" : "PUT")) return refuse(405, "method not allowed");
		if (record.kind === "get" && (record.gets ?? 0) >= MAX_GETS_PER_LINK) return refuse(410, "this link has been used up");
		if (record.kind === "put" && record.spent === true) return refuse(410, "this link has been used");
		if (record.kind === "put" && putsInFlight.has(hash)) return refuse(409, "an upload with this link is in progress");
		if (transfers >= (files.maxTransfers ?? MAX_FILE_TRANSFERS)) return refuse(429, "too many transfers at once; try again shortly");
		// Everything from here to the end of the transfer is reserved; `finally` releases it.
		transfers += 1;
		if (record.kind === "put") putsInFlight.add(hash);
		const socket = req.socket;
		socket.setTimeout(files.idleTimeoutMs ?? FILE_IDLE_TIMEOUT_MS, () => socket.destroy());
		try {
			if (record.kind === "get") return await serveGet(req, res, hash, record.attachmentId ?? "", shortId, files);
			return await servePut(req, res, hash, record.to ?? "", record.note, rest[0], shortId, files);
		} finally {
			socket.setTimeout(0);
			transfers -= 1;
			if (record.kind === "put") putsInFlight.delete(hash);
		}
	}

	async function serveGet(req: IncomingMessage, res: ServerResponse, hash: string, attachmentId: string, shortId: string, files: FileTransferOptions): Promise<void> {
		const stored = resolveAttachment(files.musterStateDir, attachmentId);
		if (stored === undefined) {
			auditHttpRefusal({ method: req.method, path: `${FILES_PREFIX}${shortId}` }, "the file is gone");
			return reply(res, 404, "not found");
		}
		if (!spendGet(options.stateDir, hash)) {
			auditHttpRefusal({ method: req.method, path: `${FILES_PREFIX}${shortId}` }, "this link has been used up");
			return reply(res, 410, "this link has been used up");
		}
		try {
			audit("(file)", { method: "GET", link: shortId, attachment: attachmentId, bytes: stored.meta.size }, null, false, undefined, "intent");
		} catch {
			return reply(res, 500, "gateway error");
		}
		const ascii = stored.meta.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
		const encoded = encodeURIComponent(stored.meta.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
		res.writeHead(200, {
			"content-type": "application/octet-stream",
			"content-length": String(statSync(stored.path).size),
			"content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
			"x-content-type-options": "nosniff",
			"cache-control": "no-store",
		});
		let outcome = "sent";
		try {
			await pipeline(createReadStream(stored.path), res);
		} catch {
			outcome = "aborted";
		}
		try {
			audit("(file)", { method: "GET", link: shortId, attachment: attachmentId, outcome }, stored.meta.size, outcome !== "sent", outcome === "sent" ? undefined : outcome, "result");
		} catch {
			// The intent line is on record.
		}
	}

	async function servePut(req: IncomingMessage, res: ServerResponse, hash: string, to: string, note: string | undefined, nameSegment: string | undefined, shortId: string, files: FileTransferOptions): Promise<void> {
		const limit = files.maxUploadBytes ?? MAX_ATTACHMENT_BYTES;
		const tooLarge = (): void => {
			res.writeHead(413, { "content-type": "application/json", connection: "close" });
			res.end(JSON.stringify({ error: `the file is larger than ${limit} bytes` }), () => req.destroy());
		};
		const declared = Number(req.headers["content-length"]);
		if (Number.isFinite(declared) && declared > limit) {
			auditHttpRefusal({ method: "PUT", path: `${FILES_PREFIX}${shortId}` }, "upload over the size cap");
			return tooLarge();
		}
		try {
			audit("(file)", { method: "PUT", link: shortId, to }, null, false, undefined, "intent");
		} catch {
			return reply(res, 500, "gateway error");
		}
		let name = "upload";
		if (nameSegment !== undefined && nameSegment !== "") {
			try {
				name = decodeURIComponent(nameSegment);
			} catch {
				name = nameSegment;
			}
		}
		let attachment: AttachmentRef;
		try {
			attachment = await storeAttachment(files.musterStateDir, { stream: req, name: sanitizeAttachmentName(name), from: GATEWAY_AGENT_ID, to, maxBytes: limit });
		} catch (error) {
			const over = error instanceof AttachmentTooLarge;
			try {
				audit("(file)", { method: "PUT", link: shortId, outcome: over ? "over the size cap" : "aborted" }, null, true, over ? "upload over the size cap" : "upload aborted", "result");
			} catch {
				// The intent line is on record.
			}
			if (over) return tooLarge();
			return void req.destroy();
		}
		const delivered = await files.deliver({ to, ...(note !== undefined ? { note } : {}), attachment }).catch((error: unknown) => ({ ok: false, detail: error instanceof Error ? error.message : String(error) }));
		try {
			audit("(file)", { method: "PUT", link: shortId, attachment: attachment.id, to, delivered: delivered.ok }, attachment.size, !delivered.ok, delivered.ok ? undefined : "not delivered", "result");
		} catch {
			// The intent line is on record.
		}
		if (!delivered.ok) {
			// The file is kept and the link stays usable, so Henry can retry.
			res.writeHead(502, { "content-type": "application/json" });
			return void res.end(JSON.stringify({ error: `stored as ${attachment.id}, not delivered: ${delivered.detail}` }));
		}
		markSpent(options.stateDir, hash);
		res.writeHead(201, { "content-type": "application/json" });
		res.end(JSON.stringify({ attachmentId: attachment.id, name: attachment.name, size: attachment.size, sha256: attachment.sha256, delivered: delivered.detail }));
	}

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const address = http.address();
		const port = typeof address === "object" && address !== null ? address.port : options.port;
		const refuse = (status: number, reason: string): void => {
			// A `/files/` URL carries a link token even when no file transfer is configured: it is never logged.
			auditHttpRefusal({ method: req.method, path: req.url?.startsWith(FILES_PREFIX) === true ? `${FILES_PREFIX}${linkShortId(req.url.slice(FILES_PREFIX.length).split(/[/?]/)[0] ?? "")}` : req.url }, reason);
			reply(res, status, reason);
		};
		const pathname = req.url?.split("?")[0] ?? "";
		if (options.files !== undefined && pathname.startsWith(FILES_PREFIX)) return handleFile(req, res, pathname, port, options.files);
		if (pathname !== MCP_PATH) return refuse(404, "not found");
		const host = req.headers.host;
		if (!hostAllowed(host, port)) return refuse(403, "host not allowed");
		if (req.headers.origin !== undefined) return refuse(403, "origin not allowed");
		if (isGatewayOff(options.stateDir)) return refuse(503, "gateway is off");
		if (req.method !== "POST") return refuse(405, "method not allowed");
		const role = roleOf(req.headers.authorization);
		if (role === undefined) return refuse(401, "unauthorized");
		const raw = await readBody(req);
		if (raw === undefined) return refuse(413, "request too large");
		let body: unknown;
		try {
			body = JSON.parse(raw);
		} catch {
			return refuse(400, "request is not JSON");
		}
		// A tools/call is audited by its handler, with the result size. Everything
		// else (initialize, tools/list, notifications) is audited here by method.
		const messages = Array.isArray(body) ? body : [body];
		for (const message of messages) {
			const rpc = message as { method?: unknown };
			if (typeof rpc?.method === "string" && rpc.method !== "tools/call") audit(`(rpc:${rpc.method})`, {}, null, false);
		}
		const server = mcpServer(role);
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
		res.on("close", () => {
			void transport.close();
			void server.close();
		});
		await server.connect(transport);
		await transport.handleRequest(req, res, body);
	}

	if (options.files !== undefined) sweepExpiredLinks(options.stateDir, now());
	await new Promise<void>((resolveListen, rejectListen) => {
		http.once("error", rejectListen);
		http.listen(options.port, "127.0.0.1", () => resolveListen());
	});
	const address = http.address();
	const port = typeof address === "object" && address !== null ? address.port : options.port;

	// The command center listener: bound to the one address it is given, never a wildcard; a failure to start
	// it is reported and the main listener stays up.
	let cc: { server: HttpServer; host: string; port: number } | undefined;
	let commandCenterError: string | undefined;
	let applyTls: ((material: { cert: string; key: string }) => void) | undefined;
	if (options.commandCenter !== undefined) {
		const listener = options.commandCenter;
		let tlsMaterial: { cert: string; key: string } | undefined;
		if (listener.tls !== undefined) {
			try {
				tlsMaterial = readTlsMaterial(listener.tls);
			} catch (error) {
				commandCenterError = `the command center certificate could not be read: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		if (commandCenterError !== undefined) {
			// The error above stands.
		} else if (isWildcardOrUnnamed(listener.host) || isIP(listener.host) === 0) commandCenterError = `the command center needs the PC's tailnet address, got ${JSON.stringify(listener.host)}; it is never bound to a wildcard`;
		else if (listener.allowedLogin.trim() === "") commandCenterError = "the command center needs the allowed login (CC_ALLOWED_LOGIN)";
		else if (listener.allowedNodes.every((id) => id.trim() === "")) commandCenterError = "the command center needs the allowed nodes (CC_ALLOWED_NODES): the login alone admits every machine under it";
		else if (listener.selfNodeId.trim() === "") commandCenterError = "the command center needs this machine's own node id from tailscaled to refuse it";
		else {
			const handleCc = createCommandCenterHandler(listener, { isOff: () => isGatewayOff(options.stateDir), refusal: auditHttpRefusal, audit: (tool, args, bytes, refused, reason, phase) => audit(tool, args, bytes, refused, reason, phase) });
			let ccHttp: HttpServer;
			const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
				const bound = ccHttp.address();
				const ccPort = typeof bound === "object" && bound !== null ? bound.port : listener.port;
				void handleCc(req, res, ccPort).catch(() => {
					if (!res.headersSent) reply(res, 500, "gateway error");
					else res.end();
				});
			};
			if (tlsMaterial !== undefined) {
				const secure: HttpsServer = createHttpsServer({ cert: tlsMaterial.cert, key: tlsMaterial.key }, onRequest);
				applyTls = (material) => secure.setSecureContext({ cert: material.cert, key: material.key });
				ccHttp = secure;
			} else ccHttp = createServer(onRequest);
			try {
				await new Promise<void>((resolveListen, rejectListen) => {
					ccHttp.once("error", rejectListen);
					ccHttp.listen(listener.port, listener.host, () => resolveListen());
				});
				const bound = ccHttp.address();
				cc = { server: ccHttp, host: listener.host, port: typeof bound === "object" && bound !== null ? bound.port : listener.port };
			} catch (error) {
				commandCenterError = `the command center listener could not bind ${listener.host}:${listener.port}: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	}

	// The loopback listener: 127.0.0.1 and nothing else, at its own port. A failure to start it is reported; the others stay up.
	let local: { server: HttpServer; port: number } | undefined;
	let commandCenterLocalError: string | undefined;
	if (options.commandCenterLocal !== undefined) {
		const listener = options.commandCenterLocal;
		const handleLocal = createLoopbackHandler(listener, { isOff: () => isGatewayOff(options.stateDir), refusal: auditHttpRefusal, audit: (tool, args, bytes, refused, reason, phase) => audit(tool, args, bytes, refused, reason, phase) });
		const localHttp = createServer((req, res) => {
			const bound = localHttp.address();
			const localPort = typeof bound === "object" && bound !== null ? bound.port : listener.port;
			void handleLocal(req, res, localPort).catch(() => {
				if (!res.headersSent) reply(res, 500, "gateway error");
				else res.end();
			});
		});
		try {
			await new Promise<void>((resolveListen, rejectListen) => {
				localHttp.once("error", rejectListen);
				localHttp.listen(listener.port, "127.0.0.1", () => resolveListen());
			});
			const bound = localHttp.address();
			local = { server: localHttp, port: typeof bound === "object" && bound !== null ? bound.port : listener.port };
		} catch (error) {
			commandCenterLocalError = `the loopback command center listener could not bind 127.0.0.1:${listener.port}: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	return {
		server: http,
		port,
		...(cc !== undefined ? { commandCenter: cc } : {}),
		...(commandCenterError !== undefined ? { commandCenterError } : {}),
		...(local !== undefined ? { commandCenterLocal: local } : {}),
		...(commandCenterLocalError !== undefined ? { commandCenterLocalError } : {}),
		reloadTls: () => {
			const files = options.commandCenter?.tls;
			if (applyTls === undefined || files === undefined) return { ok: false, detail: "the command center listener is not serving HTTPS" };
			try {
				applyTls(readTlsMaterial(files));
				return { ok: true, detail: "certificate reloaded for new connections" };
			} catch (error) {
				return { ok: false, detail: `the old certificate stays: ${error instanceof Error ? error.message : String(error)}` };
			}
		},
		close: () =>
			Promise.all([http, ...(cc !== undefined ? [cc.server] : []), ...(local !== undefined ? [local.server] : [])].map((server) => new Promise<void>((resolveClose) => {
				server.close(() => resolveClose());
				server.closeAllConnections();
			}))).then(() => undefined),
	};
}
