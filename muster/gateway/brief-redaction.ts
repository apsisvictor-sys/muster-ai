/**
 * Why `brief_write` refused a body. The redactor (lib/self-improving-redactor.ts) owns what
 * counts as a secret; this module only runs it line by line so the refusal can name the rule
 * and show the line with the matched text already masked. The matched value is never returned.
 */

import { redactSensitiveText, type RedactionSummary } from "../../core/self-improving-redactor.ts";

/** The options every outbound gateway text goes through: local paths are kept, secrets are not. */
export const BRIEF_REDACTION = { preservePaths: true, strictAssignments: true } as const;

const EXCERPT_RADIUS = 60;

export type BriefRedactionFinding = { rules: string[]; line: number | undefined; excerpt: string | undefined };

/** Undefined when the redactor would leave the body unchanged. */
export function findBriefRedaction(content: string): BriefRedactionFinding | undefined {
	const total: RedactionSummary = { total: 0, categories: {} };
	if (redactSensitiveText(content, { ...BRIEF_REDACTION, summary: total }) === content) return undefined;
	const rules = Object.keys(total.categories);
	const lines = content.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const masked = redactSensitiveText(lines[index]!, BRIEF_REDACTION);
		if (masked === lines[index]) continue;
		const at = masked.indexOf("[REDACTED]");
		const start = Math.max(0, at - EXCERPT_RADIUS);
		const end = Math.min(masked.length, at + "[REDACTED]".length + EXCERPT_RADIUS);
		return { rules, line: index + 1, excerpt: `${start > 0 ? "..." : ""}${masked.slice(start, end)}${end < masked.length ? "..." : ""}` };
	}
	// A match that only exists across lines (a private key block): the rule is known, the line is not.
	return { rules, line: undefined, excerpt: undefined };
}

export function briefRedactionMessage(finding: BriefRedactionFinding): string {
	const where = finding.line === undefined ? "" : `, first at line ${finding.line}: ${JSON.stringify(finding.excerpt)}`;
	return `content would be redacted by rule ${finding.rules.join(", ")}${where}. Remove or rephrase that text; the matched value is masked here.`;
}
