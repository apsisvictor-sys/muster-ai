/**
 * MG6 of the messaging agent (VR24-82 R2, VR24-85 gate list point 6): the registry of sessions that
 * handle chat text.
 *
 * The command center's loopback listener serves a lane's live session (`feed`) to any process on the PC,
 * which is the same reach `muster` has. A session that reads or writes chat text would put that text in
 * front of the same processes, so the loopback feed withholds it. Lanes named for the messaging work are
 * withheld by name (`CHAT_TEXT_LANE`, `gateway/command-center-local.ts`); any other session that will
 * handle chat text, the architect's when it reads the archive for instance, is registered here before it
 * does. The tailnet listener is not affected: the operator's page is where chat text belongs.
 *
 * The file is `<muster state dir>/chat-text-sessions.json`, a JSON array of lane ids or seat roles. A file
 * that exists and cannot be read withholds every session, because the registry then cannot say which
 * ones hold chat text: the default is withheld, and an absent file is an empty registry.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CHAT_SESSIONS_FILE = "chat-text-sessions.json";

export function chatSessionsPath(stateDir: string): string {
	return join(stateDir, CHAT_SESSIONS_FILE);
}

/** The registered sessions, or `undefined` when the file exists and cannot be read. */
export function readChatTextSessions(stateDir: string): string[] | undefined {
	const path = chatSessionsPath(stateDir);
	if (!existsSync(path)) return [];
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) return undefined;
		return (parsed as string[]).map((entry) => entry.trim()).filter((entry) => entry !== "");
	} catch {
		return undefined;
	}
}

/** Registers a session as one that handles chat text. Idempotent. */
export function markChatTextSession(stateDir: string, lane: string): void {
	const name = lane.trim();
	if (name === "") throw new Error("a session name is required");
	const held = readChatTextSessions(stateDir);
	if (held === undefined) throw new Error(`${chatSessionsPath(stateDir)} is not a JSON array of session names: read it by hand`);
	if (held.includes(name)) return;
	const path = chatSessionsPath(stateDir);
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify([...held, name], null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, path);
}

/** The loopback listener's `feedWithheld`: read on every request, so a session registered now is withheld at once. */
export function chatTextSessionWithheld(stateDir: string): (lane: string) => boolean {
	return (lane) => {
		const held = readChatTextSessions(stateDir);
		return held === undefined || held.includes(lane);
	};
}
