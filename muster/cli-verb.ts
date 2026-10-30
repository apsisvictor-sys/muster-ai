/**
 * The verb a `muster` argv runs, for the callers that need it before `cli-main.ts` runs:
 * the entry that loads only that verb's module, and the start file that decides whether the
 * verb needs Pi's port adapters.
 *
 * It reads argv the way `cli-main.ts`'s `globalArgv` does: `--repo <path>` and `--agent <id>`
 * before the verb take a value, any other flag is skipped, the first plain word is the verb.
 * (`globalArgv` stays private there: the `claude-hook` and `seat` bundles hash `cli-main.ts`.)
 */
export function verbOf(argv: readonly string[]): string | undefined {
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (arg === "--repo" || arg === "--agent") {
			index += 1;
			continue;
		}
		if (!arg.startsWith("-")) return arg;
	}
	return undefined;
}
