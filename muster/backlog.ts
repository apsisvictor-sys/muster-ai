/**
 * The backlog table's shape: the columns the hand table used and the generated view keeps, one parse of a table
 * and one render of it.
 *
 * CUTOVER (2026-10-29) retired the hand table: the work-item records are the queue, and no script reads
 * `handoffs/backlog.md` any more. What stays here is the table's vocabulary and its parse, because the generated
 * view (OL8) renders those columns and the cutover's own comparison reads the hand table's snapshot with the
 * same parse the table always had. Nothing here reads a file or decides anything.
 *
 * The parse is driven by the header, never by column position: the header row that carries both `id`
 * and `state` names the table, the rows under it are read by those names, and the table ends at the
 * first line that is not a row. Every other table, every prose line and every other row is ignored.
 */

/**
 * The backlog table's columns, in file order, as the hand-kept table spelled them. The generated file
 * (OL8) renders these names back, so the hand table and the generated one are one table.
 */
export const BACKLOG_COLUMNS = ["id", "outcome", "state", "brief / source", "deps", "sprint goal"] as const;
export type BacklogColumn = (typeof BACKLOG_COLUMNS)[number];

/** One table row's cells, without the leading and trailing pipe. */
function cells(line: string): string[] {
	const trimmed = line.trim();
	const body = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
	const end = body.endsWith("|") ? body.slice(0, -1) : body;
	return end.split("|").map((cell) => cell.trim());
}

/** The `|---|:--:|` row under a header: it belongs to the table but carries no data. */
function isSeparator(line: string): boolean {
	if (!line.trim().startsWith("|")) return false;
	return cells(line).every((cell) => /^:?-{1,}:?$/.test(cell));
}

/** The column indexes of `id` and `state` in a header row, or undefined when this row is not that header. */
function headerColumns(line: string): { id: number; state: number } | undefined {
	if (!line.trim().startsWith("|")) return undefined;
	const names = cells(line).map((cell) => cell.toLowerCase());
	const id = names.indexOf("id");
	const state = names.indexOf("state");
	if (id === -1 || state === -1) return undefined;
	return { id, state };
}

/** One row of the backlog table: its cells in header order, and its cells by column name (lower-case header). */
export type BacklogRow = { cells: string[]; column: Record<string, string> };

/** The backlog's table: the header names, and the rows under them, in file order. */
export type BacklogTable = { ok: true; header: string[]; rows: BacklogRow[] } | { ok: false; reason: string };

/**
 * The backlog's table, header and rows: the one parse of a table in this shape. The generated view (OL8)
 * renders back from the work-item records through it, and the cutover's comparison reads the hand table's
 * snapshot through it, so the two views cannot be read two different ways.
 */
export function parseBacklogTable(text: string, path = "backlog"): BacklogTable {
	const lines = text.split(/\r?\n/);
	let header: string[] | undefined;
	const rows: BacklogRow[] = [];
	for (const line of lines) {
		if (header === undefined) {
			if (headerColumns(line) !== undefined) header = cells(line).map((cell) => cell.toLowerCase());
			continue;
		}
		// The table ends at the first line that is not one of its rows; a second table is its own business.
		if (!line.trim().startsWith("|")) break;
		if (isSeparator(line)) continue;
		const row = cells(line);
		const column: Record<string, string> = {};
		header.forEach((name, index) => {
			if (name !== "") column[name] = row[index] ?? "";
		});
		rows.push({ cells: row, column });
	}
	if (header === undefined) return { ok: false, reason: `${path}: no table header with both an id and a state column` };
	return { ok: true, header, rows };
}

/** The same table written back: the header line, its separator, and one row per record. */
export function renderBacklogTable(header: readonly string[], rows: readonly Record<string, string>[]): string {
	const line = (values: readonly string[]): string => `| ${values.map((value) => value.trim().replace(/\|/g, "\\|")).join(" | ")} |`;
	const lines = [line(header), line(header.map(() => "---"))];
	for (const row of rows) lines.push(line(header.map((name) => row[name] ?? "")));
	return `${lines.join("\n")}\n`;
}
