/**
 * `core/excluded-cwd.ts` — the one owner of the excluded-project rule (S3 of
 * `plans/repo/modular-repo-blueprint-2026-10-17.md`): work for these projects is
 * client data, so it never reaches a cloud classifier.
 */

/** Work for these projects is client data, so it never reaches a cloud classifier. */
export function isExcludedCwd(cwd: string): boolean {
	return /crm-app|estate[ _-]?assistant|estateassistant/i.test(cwd);
}
