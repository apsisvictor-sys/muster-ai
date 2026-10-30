/**
 * MG3 (VR24-62, rules G11 and G14 as corrected by VR24-71): how a thread names itself
 * in an audit line.
 *
 * The command center's audit file is read by the public gateway's `audit_read`, which
 * shows it to Henry and Bob. A WhatsApp chat id is a phone number, so an audit line
 * holds the *fingerprint* of a thread — the first 12 hex digits of the SHA-256 of its
 * id — and never the id, a name or text. MG7's page writes its audit lines the same
 * way; this function is the one owner of the fingerprint.
 */
import { createHash } from "node:crypto";

/**
 * The fingerprint of a thread: the first 12 hex digits of the SHA-256 of its id.
 * The same thread always has the same fingerprint, and the fingerprint names no one:
 * it cannot be turned back into a chat id.
 */
export function threadFingerprint(threadId: string): string {
	return createHash("sha256").update(threadId).digest("hex").slice(0, 12);
}
