/**
 * `dashboard_login` (UM14): the monitor bot's dashboard credentials, from the vault to the bot and nowhere else.
 *
 * The account picks the vault (R1 final, VR16), so each account has its own run-as consumer layer in
 * `secrets/consumers.json`. The read goes through `infisical-agent run-as`, never a direct vault call:
 * the child is this process's own node printing the three named variables, which this module parses in
 * memory. run-as's access log and the gateway audit (bytes, never text) are the record.
 *
 * What leaves is the username, the password and one TOTP code. The TOTP secret never does, and no
 * refusal names a vault value: a refusal names the provider and the account, which the caller supplied.
 */

import { execFile } from "node:child_process";
import { SIGNAL_ACCOUNTS, type SignalAccount } from "../signals.ts";
import { totpCodeWhenFresh, TotpSecretError, type TotpCode } from "../../core/totp.ts";

/** The run-as consumer layer for each account's `/dashboards` folder (secrets/consumers.json). */
export const DASHBOARD_CONSUMERS: Readonly<Record<SignalAccount, string>> = {
	personal: "gateway-dashboards",
	"acme-realty": "gateway-dashboards-work",
	studio: "gateway-dashboards-studio",
};

const PROVIDER = /^[a-z0-9][a-z0-9-]{0,39}$/;
const READ_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT_BYTES = 64 * 1024;

/** Thrown for anything the caller may be told. The message never holds a vault value. */
export class DashboardLoginRefusal extends Error {}

/**
 * Reads the named variables of one run-as consumer. Absent names are left out of the answer.
 * A consumer that cannot be read rejects with an error whose message holds no value.
 */
export type DashboardSecretsReader = (consumer: string, names: readonly string[]) => Promise<Record<string, string>>;

export type DashboardLoginDeps = {
	read: DashboardSecretsReader;
	now?: () => Date;
	sleep?: (ms: number) => Promise<void>;
};

export type DashboardLogin = {
	provider: string;
	account: SignalAccount;
	username: string;
	password: string;
	/** Absent when no TOTP secret is stored for the account. */
	totp: TotpCode | null;
};

/** `<PROVIDER>_DASHBOARD_<FIELD>`: the inventory id upper-cased with `-` as `_` (SK11). */
export function dashboardEnvNames(provider: string): { username: string; password: string; totpSecret: string } {
	const base = `${provider.toUpperCase().replace(/-/g, "_")}_DASHBOARD`;
	return { username: `${base}_USERNAME`, password: `${base}_PASSWORD`, totpSecret: `${base}_TOTP_SECRET` };
}

export function parseDashboardRequest(args: Record<string, unknown>): { provider: string; account: SignalAccount } {
	const provider = args["provider"];
	const account = args["account"];
	if (typeof provider !== "string" || !PROVIDER.test(provider.trim().toLowerCase())) throw new DashboardLoginRefusal("provider must be a provider id such as xai or opencode-go");
	if (typeof account !== "string" || !(SIGNAL_ACCOUNTS as readonly string[]).includes(account)) throw new DashboardLoginRefusal(`account must be one of ${SIGNAL_ACCOUNTS.join(", ")}`);
	return { provider: provider.trim().toLowerCase(), account: account as SignalAccount };
}

export async function dashboardLogin(deps: DashboardLoginDeps, request: { provider: string; account: SignalAccount }): Promise<DashboardLogin> {
	const { provider, account } = request;
	const names = dashboardEnvNames(provider);
	let secrets: Record<string, string>;
	try {
		secrets = await deps.read(DASHBOARD_CONSUMERS[account], [names.username, names.password, names.totpSecret]);
	} catch {
		throw new DashboardLoginRefusal(`the vault for ${account} could not be read for ${provider}`);
	}
	const username = secrets[names.username];
	const password = secrets[names.password];
	if (username === undefined || username === "" || password === undefined || password === "") {
		throw new DashboardLoginRefusal(`no dashboard login is stored for ${provider} (${account})`);
	}
	const secret = secrets[names.totpSecret];
	let totp: TotpCode | null = null;
	if (secret !== undefined && secret !== "") {
		try {
			totp = await totpCodeWhenFresh(secret, { ...(deps.now !== undefined ? { now: deps.now } : {}), ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}) });
		} catch (error) {
			if (!(error instanceof TotpSecretError)) throw error;
			throw new DashboardLoginRefusal(`the stored TOTP secret for ${provider} (${account}) is not valid base32`);
		}
	}
	return { provider, account, username, password, totp };
}

/** The child run-as starts: it prints only the variables named in argv, as one JSON object. */
const PRINT_NAMED_ENV = "const out={};for(const n of process.argv.slice(1)){const v=process.env[n];if(v!==undefined&&v!==\"\")out[n]=v}process.stdout.write(JSON.stringify(out))";

/** The real reader: `infisical-agent run-as <consumer> -- node -e <script> <names>`. */
export function runAsReader(options: { bin: string; node?: string; timeoutMs?: number }): DashboardSecretsReader {
	return (consumer, names) =>
		new Promise((resolve, reject) => {
			execFile(
				options.bin,
				["run-as", consumer, "--", options.node ?? process.execPath, "-e", PRINT_NAMED_ENV, ...names],
				{ timeout: options.timeoutMs ?? READ_TIMEOUT_MS, maxBuffer: OUTPUT_LIMIT_BYTES, encoding: "utf8" },
				(error, stdout) => {
					// The message is the exit status only: stderr is run-as's own and is not passed on.
					if (error !== null) return reject(new Error(`run-as ${consumer} failed`));
					try {
						const parsed: unknown = JSON.parse(stdout);
						if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
						const out: Record<string, string> = {};
						for (const [name, value] of Object.entries(parsed)) if (typeof value === "string" && names.includes(name)) out[name] = value;
						resolve(out);
					} catch {
						reject(new Error(`run-as ${consumer} printed something unreadable`));
					}
				},
			);
		});
}
