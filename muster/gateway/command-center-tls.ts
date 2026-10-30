/**
 * HTTPS for the command center's tailnet listener (VR24-74, blueprint WP1c point 7).
 *
 * The gateway terminates TLS itself with the certificate `tailscale cert <machine>.<tailnet>.ts.net` issues, so the
 * peer address stays the caller's tailnet address and `whois` still decides. `tailscale serve` is not used (it reaches
 * the backend over loopback with identity in headers) and Funnel never is. The certificate and key live in the
 * gateway state folder, mode 0600. A weekly user timer runs `muster gateway cert-renew`, which renews them and tells
 * the gateway to reload them with SIGHUP; the reload affects new handshakes only, so an open page's feed keeps running.
 *
 * If the tailnet has HTTPS switched off, `tailscale cert` fails. That is reported as blocked, nothing is replaced, and
 * the listener stays on HTTP until the switch is on (the admin switch is the operator's).
 */

import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createSecureContext } from "node:tls";

export const CERT_FILE = "cc-cert.pem";
export const KEY_FILE = "cc-key.pem";
export const GATEWAY_UNIT = "muster-gateway.service";

export type TlsFiles = { certFile: string; keyFile: string };

/** Where the certificate and key live: the gateway state folder. */
export function tlsFilesIn(stateDir: string): TlsFiles {
	return { certFile: join(stateDir, CERT_FILE), keyFile: join(stateDir, KEY_FILE) };
}

/** True when both files exist, so the listener can start on HTTPS. */
export function tlsFilesPresent(files: TlsFiles): boolean {
	return existsSync(files.certFile) && existsSync(files.keyFile);
}

/** The PEM pair, checked to be a certificate with its own key. Throws when it is not. */
export function readTlsMaterial(files: TlsFiles): { cert: string; key: string } {
	const cert = readFileSync(files.certFile, "utf8");
	const key = readFileSync(files.keyFile, "utf8");
	createSecureContext({ cert, key });
	return { cert, key };
}

export type Run = (file: string, args: readonly string[]) => Promise<{ ok: boolean; output: string }>;

const runFile: Run = (file, args) =>
	new Promise((done) => {
		execFile(file, [...args], { timeout: 60_000, encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
			done({ ok: error === null, output: `${stderr}${stdout}`.trim() });
		});
	});

export type RenewOutcome =
	| { ok: true; reloaded: boolean; detail: string; notAfter: string }
	| { ok: false; blocked: true; detail: string }
	| { ok: false; blocked: false; detail: string };

/**
 * Renews the certificate for `dnsName` into `files`. The new pair is written beside the old one, checked (a certificate that
 * names this machine, with a key that matches) and only then moved into place, so a failed renewal leaves the working pair alone.
 * `reload` tells the running gateway; a gateway that is not running just reads the new pair when it starts.
 */
export async function renewCertificate(options: { dnsName: string; files: TlsFiles; tailscaleBin?: string; run?: Run; reload?: () => Promise<{ ok: boolean; detail: string }> }): Promise<RenewOutcome> {
	const run = options.run ?? runFile;
	const reload = options.reload ?? (async () => {
		const result = await run("systemctl", ["--user", "kill", "--signal=HUP", GATEWAY_UNIT]);
		return { ok: result.ok, detail: result.output };
	});
	const next: TlsFiles = { certFile: `${options.files.certFile}.new`, keyFile: `${options.files.keyFile}.new` };
	const cleanUp = (): void => {
		rmSync(next.certFile, { force: true });
		rmSync(next.keyFile, { force: true });
	};
	const issued = await run(options.tailscaleBin ?? "tailscale", ["cert", "--cert-file", next.certFile, "--key-file", next.keyFile, options.dnsName]);
	if (!issued.ok) {
		cleanUp();
		return { ok: false, blocked: true, detail: `tailscale cert failed (is HTTPS enabled for the tailnet in the admin console?): ${issued.output.split("\n").slice(-1)[0] ?? ""}`.trim() };
	}
	let notAfter: string;
	try {
		chmodSync(next.certFile, 0o600);
		chmodSync(next.keyFile, 0o600);
		const { cert } = readTlsMaterial(next);
		const parsed = new X509Certificate(cert);
		if (parsed.checkHost(options.dnsName) === undefined) throw new Error(`the certificate does not name ${options.dnsName}`);
		notAfter = parsed.validTo;
	} catch (error) {
		cleanUp();
		return { ok: false, blocked: false, detail: `the issued certificate was not usable: ${error instanceof Error ? error.message : String(error)}` };
	}
	renameSync(next.keyFile, options.files.keyFile);
	renameSync(next.certFile, options.files.certFile);
	const reloaded = await reload();
	return { ok: true, reloaded: reloaded.ok, detail: reloaded.ok ? "renewed and reloaded" : `renewed; the gateway was not reloaded (${reloaded.detail || "it may not be running"}) and reads the new pair when it starts`, notAfter };
}
