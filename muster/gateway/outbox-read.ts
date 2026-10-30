/**
 * Per-recipient read state for `outbox_read` (VR24-12 C8).
 *
 * The grokbot outbox is one address in the ledger, and its `accepted` / `delivered` state is one flag per message.
 * Henry's read is that flag: `outbox_read` as Henry marks the message delivered, so every other consumer of the
 * flag (`muster lanes`, the unread watchdog) keeps meaning "Henry has not read it". Every other recipient (the
 * monitor bearer, a named reader such as Bob) keeps its own list of message ids it has been shown, here in the
 * gateway's state dir, so reading never changes what anyone else sees.
 */

import { join } from "node:path";
import { readJsonSettingsFile, updateJsonSettingsFile } from "../../core/atomic-settings.ts";

export const OUTBOX_READ_FILE = "outbox-read.json";
/** The recipient whose read is the ledger's own `delivered` flag. */
export const PRIMARY_READER = "henry";
/** The recipient the monitor bearer reads as. */
export const MONITOR_READER = "monitor";
/** At most this many ids are kept per recipient; the oldest go first. */
const KEPT_IDS = 500;
/** A reader name: lower-case after normalising, short, no path characters. */
export const READER_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;

type ReadState = { version: 1; readers: Record<string, { ids: string[] }> };
const EMPTY: ReadState = { version: 1, readers: {} };

const fileOf = (dir: string): string => join(dir, OUTBOX_READ_FILE);

/** The ids one recipient has been shown. */
export function idsSeenBy(dir: string, reader: string): Set<string> {
	return new Set(readJsonSettingsFile<ReadState>(fileOf(dir), EMPTY).readers[reader]?.ids ?? []);
}

/** Record that `reader` has been shown `ids`. Under the settings writer's lock, atomic. */
export function markSeenBy(dir: string, reader: string, ids: string[]): void {
	if (ids.length === 0) return;
	updateJsonSettingsFile<ReadState>(fileOf(dir), EMPTY, (state) => {
		const kept = [...(state.readers[reader]?.ids ?? []).filter((id) => !ids.includes(id)), ...ids].slice(-KEPT_IDS);
		return { version: 1, readers: { ...state.readers, [reader]: { ids: kept } } };
	});
}
