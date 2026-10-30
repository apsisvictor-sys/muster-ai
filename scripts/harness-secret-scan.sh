#!/usr/bin/env bash
# Secret scan over the history that a split carries out of this repository
# (modular-repo blueprint RD6/RS3 step 2, OL12 D2): the one owner of "is there a
# secret in these commits".
#
#   scripts/harness-secret-scan.sh <rev-or-range> [--allow <file>] [--split-base <commit>]
#
# Every commit in `git rev-list <rev-or-range>` is searched with the exact pattern
# list below, and every tree is checked for the file and folder names that hold
# personal data. A hit prints the commit, the path and the pattern's NAME — never
# the matched text — so the output is safe to paste into a report, an ask or a
# commit message. Nothing here prints a value, and nothing rewrites what it found.
#
# Two modes, chosen per commit by `--split-base` (the split's own tip):
#
#   whole-tree     every commit reachable from the split base, and every commit
#                  when no base is given: each commit's whole tree is searched.
#                  That is the history the split moved, reviewed once.
#   added-lines    every commit after the split base: only the lines the commit
#                  ADDS are searched (`git diff -U0` against the first parent, or
#                  against the empty tree for a root commit). The fixtures that
#                  history carried were reviewed at the base, so re-scanning the
#                  same tree on every later commit would re-flag them forever; a
#                  secret is new only as a new line. A merge is diffed against its
#                  first parent, which reports everything the merge brought in.
#                  Both diffs pass `--no-renames`, so a rename or a move is read as
#                  a delete plus an add: the content it carries is scanned and
#                  judged by its NEW path, and the ambient `diff.renames` cannot
#                  make the same push pass on one machine and fail on another. A
#                  path-keyed entry for the old path therefore does not cover it.
#
# A broken scan must never look like a clean one: `git grep -P` is probed once
# before any commit is read, the status of every `git grep`, `git diff` and
# `git ls-tree` is checked, and anything other than "matched" or "no match" stops
# the run with exit 2.
#
# The allow list holds hits that a reviewer accepted. Blank lines and `#` comments
# are ignored, and each entry is one of:
#
#   <commit> <path>                  a whole-tree hit, keyed by the split commit
#                                    the scan printed and the path (an optional
#                                    third column names the pattern);
#   = <path> <pattern> <sha256>      an added-line hit after the split base, keyed
#                                    by path, pattern name and the SHA-256 of the
#                                    matched line. Only the hash is stored, so a
#                                    different line — a new secret written into an
#                                    allowed fixture path — is still a hit;
#   = <path> <file-name|state-folder>
#                                    an added file or folder name after the split
#                                    base, which carries no line to hash.
#
# RS3's rule is that a hit in a test fixture holding a made-up value goes to the
# architect, who adds it there by the key the scan prints; any other hit stops the
# push and goes to the operator.
#
# Exit codes: 0 no hit outside the allow list, 1 at least one hit, 2 usage, not a
# git repository, an unusable `git grep -P` or an unusable `--split-base`.

set -uo pipefail

usage() {
	echo "usage: harness-secret-scan.sh <rev> [--allow <file>] [--split-base <commit>]" >&2
	exit 2
}

[ $# -ge 1 ] || usage
rev="$1"
shift
allow_file=""
split_base=""
while [ $# -gt 0 ]; do
	case "$1" in
		--allow)
			[ $# -ge 2 ] || usage
			allow_file="$2"
			shift 2
			;;
		--split-base)
			[ $# -ge 2 ] || usage
			split_base="$2"
			shift 2
			;;
		*) usage ;;
	esac
done

git rev-parse --git-dir >/dev/null 2>&1 || {
	echo "harness-secret-scan: not inside a git repository" >&2
	exit 2
}
# A single revision or a range (`before..after`): both are what callers scan, and
# `git rev-list` owns the meaning of each.
git rev-list --max-count=1 "$rev" >/dev/null 2>&1 || {
	echo "harness-secret-scan: no commits in: $rev" >&2
	exit 2
}

# The patterns are PCRE. A git built without them exits 128 on every one of them and
# prints no paths, which would read as "no hits" for the whole scan — so probe the
# engine once, on the first commit of the range, and refuse if it cannot run: 0 is a
# match, 1 is no match, anything else is a broken grep.
git grep -P -I -l -e '(?i)x' "$(git rev-list --max-count=1 "$rev")" -- . >/dev/null 2>&1
probe=$?
if [ "$probe" -gt 1 ]; then
	echo "harness-secret-scan: git grep -P is unusable here (status $probe); refusing to report a scan it cannot run" >&2
	exit 2
fi

# The split base: commits reachable from it are the reviewed whole-tree history, and
# everything else in the range is scanned for added lines only. An unknown base is a
# usage error, never a silent fallback to one mode or the other.
declare -A split_commits=()
if [ -n "$split_base" ]; then
	split_base_sha=$(git rev-parse --verify --quiet "${split_base}^{commit}")
	if [ -z "$split_base_sha" ]; then
		echo "harness-secret-scan: unusable split base: $split_base" >&2
		exit 2
	fi
	split_base="$split_base_sha"
	while IFS= read -r reachable; do
		split_commits["$reachable"]=1
	done < <(git rev-list "$split_base")
fi

# The pattern list and its names, index for index (RS3 step 2).
NAMES=(
	private-key
	anthropic-key
	sk-key
	xai-key
	github-token
	aws-access-key
	google-api-key
	slack-token
	jwt
	secret-assignment
)
PATTERNS=(
	'-----BEGIN [A-Z ]*PRIVATE KEY-----'
	'sk-ant-[A-Za-z0-9_-]{20,}'
	'\bsk-[A-Za-z0-9_-]{20,}'
	'\bxai-[A-Za-z0-9]{20,}'
	'\bgh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}'
	'\bAKIA[0-9A-Z]{16}\b'
	'\bAIza[0-9A-Za-z_-]{35}\b'
	'\bxox[abprs]-[A-Za-z0-9-]{10,}'
	'\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
	'(?i)(api[_-]?key|secret|token|password|bearer)["'"'"'\s]*[:=]\s*["'"'"'][A-Za-z0-9_./+-]{16,}["'"'"']'
)

# Names that must never travel: the exact file names, and any path with a state/ folder.
FILE_NAMES=('.env' 'auth.json' 'accounts.json' 'ledger.jsonl' 'identity-cache.json')

# The empty tree, for a root commit: every line of it is an added line.
EMPTY_TREE=4b825dc642cb6eb9a060e54bf8d69288fbee4904
# Field separator between a path and its added line, so one record carries both.
US=$'\037'

# A whole-tree hit: the reviewed (commit, path) pair.
allowed() {
	local commit="$1" path="$2"
	[ -n "$allow_file" ] || return 1
	[ -f "$allow_file" ] || return 1
	awk -v c="$commit" -v p="$path" '$1 == c && $2 == p { found = 1 } END { exit(found ? 0 : 1) }' "$allow_file"
}

# An added-line hit: path, pattern name and the line's hash; a name hit has no line,
# so its hash is empty and only path and rule are compared.
allowed_added() {
	local path="$1" name="$2" hash="$3"
	[ -n "$allow_file" ] || return 1
	[ -f "$allow_file" ] || return 1
	awk -v p="$path" -v n="$name" -v h="$hash" \
		'$1 == "=" && $2 == p && $3 == n && (h == "" || $4 == h) { found = 1 } END { exit(found ? 0 : 1) }' "$allow_file"
}

# The name rule, for one path: a data file name, or a state/ folder in the path.
name_rule() {
	local path="$1" base name
	base="${path##*/}"
	for name in "${FILE_NAMES[@]}"; do
		if [ "$base" = "$name" ]; then
			echo "file-name"
			return
		fi
	done
	case "/$path/" in
		*/state/*) echo "state-folder" ;;
	esac
}

# Every commit's whole tree: the history up to the split base, reviewed once.
scan_whole_commit() {
	local commit="$1" i found path rule out status
	for i in "${!PATTERNS[@]}"; do
		out=$(git grep -P -I -l -e "${PATTERNS[$i]}" "$commit" -- .)
		status=$?
		if [ "$status" -gt 1 ]; then
			echo "harness-secret-scan: git grep failed (status $status) at $commit for ${NAMES[$i]}" >&2
			exit 2
		fi
		while IFS= read -r found; do
			# `git grep -l <tree-ish>` prefixes each path with the commit and a colon.
			path="${found#"$commit":}"
			[ -n "$path" ] || continue
			allowed "$commit" "$path" && continue
			printf '%s %s %s\n' "$commit" "$path" "${NAMES[$i]}"
			hits=$((hits + 1))
		done <<< "$out"
	done
	out=$(git ls-tree -r --name-only "$commit")
	status=$?
	if [ "$status" -ne 0 ]; then
		echo "harness-secret-scan: git ls-tree failed (status $status) at $commit" >&2
		exit 2
	fi
	while IFS= read -r path; do
		[ -n "$path" ] || continue
		rule=$(name_rule "$path")
		[ -n "$rule" ] || continue
		allowed "$commit" "$path" && continue
		printf '%s %s %s\n' "$commit" "$path" "$rule"
		hits=$((hits + 1))
	done <<< "$out"
}

# The lines one commit adds: `path<US>line` per added line, from its diff against its
# first parent. A missing parent (a root commit, or a shallow clone that cannot see
# it) falls back to the empty tree, so every line counts as added.
added_lines() {
	local commit="$1" parent out status
	parent=$(git rev-parse --verify --quiet "${commit}^1")
	[ -n "$parent" ] || parent="$EMPTY_TREE"
	# `--no-renames`: a rename carries its content with no added line, so with rename
	# detection on the file's text is never searched at all. Delete plus add makes
	# every carried line an added line at its new path, where the allow key for the
	# old path correctly does not match. The flag also pins the reading, so the scan
	# does not depend on the caller's `diff.renames`.
	out=$(git diff -U0 --no-color --no-renames "$parent" "$commit")
	status=$?
	if [ "$status" -ne 0 ]; then
		echo "harness-secret-scan: git diff failed (status $status) at $commit" >&2
		exit 2
	fi
	printf '%s\n' "$out" | awk -v us="$US" '
		/^\+\+\+ / { path = substr($0, 7); next }
		/^\+/ { print path us substr($0, 2) }
	'
}

# Only what a commit adds, so a reviewed fixture is not re-flagged on every commit
# that still carries it.
scan_added_commit() {
	local commit="$1" records rec path line hash rule out status i
	records=$(added_lines "$commit")
	for i in "${!PATTERNS[@]}"; do
		[ -n "$records" ] || break
		out=$(printf '%s\n' "$records" | grep -P -e "${PATTERNS[$i]}")
		status=$?
		if [ "$status" -gt 1 ]; then
			echo "harness-secret-scan: grep failed (status $status) at $commit for ${NAMES[$i]}" >&2
			exit 2
		fi
		[ "$status" -eq 0 ] || continue
		while IFS= read -r rec; do
			[ -n "$rec" ] || continue
			path="${rec%%"$US"*}"
			line="${rec#*"$US"}"
			# The record carries the path, so confirm the pattern on the line alone.
			printf '%s\n' "$line" | grep -qP -e "${PATTERNS[$i]}" || continue
			hash=$(printf '%s' "$line" | sha256sum)
			hash="${hash%% *}"
			allowed_added "$path" "${NAMES[$i]}" "$hash" && continue
			printf '%s %s %s %s\n' "$commit" "$path" "${NAMES[$i]}" "$hash"
			hits=$((hits + 1))
		done <<< "$out"
	done
	# A data file or a state/ folder is new only where this commit writes the path.
	# `--no-renames` here too: a data file moved to a name the rules do not match is
	# still a path this commit writes, and the vacated path is reported as well.
	out=$(git diff --name-only --no-renames "$(git rev-parse --verify --quiet "${commit}^1" || echo "$EMPTY_TREE")" "$commit")
	status=$?
	if [ "$status" -ne 0 ]; then
		echo "harness-secret-scan: git diff --name-only failed (status $status) at $commit" >&2
		exit 2
	fi
	while IFS= read -r path; do
		[ -n "$path" ] || continue
		rule=$(name_rule "$path")
		[ -n "$rule" ] || continue
		allowed_added "$path" "$rule" "" && continue
		printf '%s %s %s\n' "$commit" "$path" "$rule"
		hits=$((hits + 1))
	done <<< "$out"
}

hits=0
commits=0
whole_commits=0
added_commits=0
for commit in $(git rev-list "$rev"); do
	commits=$((commits + 1))
	if [ -n "$split_base" ] && [ -z "${split_commits[$commit]:-}" ]; then
		added_commits=$((added_commits + 1))
		scan_added_commit "$commit"
	else
		whole_commits=$((whole_commits + 1))
		scan_whole_commit "$commit"
	fi
done

echo "== harness-secret-scan: commits=$commits hits=$hits rev=$rev allow=${allow_file:-none} split-base=${split_base:-none} whole-tree=$whole_commits added-lines=$added_commits ==" >&2
[ "$hits" -eq 0 ]
