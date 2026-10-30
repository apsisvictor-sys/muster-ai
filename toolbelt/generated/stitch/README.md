# Universal Google Stitch CLI

Project-agnostic wrapper around `@google/stitch-sdk` for the operator/Pi.

## Commands

```bash
stitch status --json
stitch list-tools --json
stitch list-projects --json
stitch init --project-title "Project Name" --design-file DESIGN.md
stitch generate --prompt-file .stitch/prompts/example.md --design-file .stitch/DESIGN.md --project-title "Project Name"
```

## Auth

The CLI reads auth from environment first, then existing local MCP configs. It never prints secret values.

Known working source on this machine:

```text
~/.gemini/antigravity/mcp_config.json
```

## Per-project convention

Run `stitch init` inside a project to create:

```text
.stitch/
  DESIGN.md
  prompts/
  output/
  stitch.json
  README.md
```

Generated HTML/PNG files are written to `.stitch/output/`; screen/project metadata is written to `.stitch/stitch.json`.

## Toolbelt

Provider id: `stitch`

Safe operations: `status`, `list-tools`, `list-projects`.

Approval-gated operations: `init`, `generate`.
