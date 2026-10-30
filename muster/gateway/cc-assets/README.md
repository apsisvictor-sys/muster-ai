# Command center assets

What `GET /cc/assets/<file>` serves (an explicit list built from `ui/manifest.json` in `../command-center.ts`); every
other name is a 404. The page loads nothing from outside the PC.

## `ui/`: the pinned design library

`ui/` is a copy of the [graphite-ui](https://github.com/muster-dev/graphite-ui) design library at the tag
`VERSION` names, written by `scripts/vendor-graphite-ui.sh <tag>` and committed with the files it copies. Do not edit
these files by hand: a change reaches the page as a new tag and a new run of the script, which is what keeps the copy
equal to a tag anybody can check.

| File | Content type |
|---|---|
| `ui/index.js`, `ui/motion.js`, `ui/elements/*.js` | `text/javascript; charset=utf-8` |
| `ui/tokens.css`, `ui/components.css` | `text/css; charset=utf-8` |

- `VERSION` holds `<tag> <commit>` on one line.
- `manifest.json` holds `{tag, commit, files: [{file, type}]}`. It is the one list of what this directory serves;
  the gateway reads it when its module loads, so a file that is on disk but not in the manifest is not served, and a
  name the manifest lists without the file beside it stops the gateway with a named error.
- The page loads `ui/index.js` as a nonce'd module and the two stylesheets by `<link>`; the CSP (`commandCenterCsp`)
  allows `script-src` the nonce alone and `style-src 'self' 'unsafe-inline'`.

`README.md` is served from here too, so the list and the licences are readable over the same route.

## Type

The page uses the system stack: Segoe UI Variable on Windows, SF on the iPhone, with tabular numerals (blueprint D37).
The Onest, Unbounded and JetBrains Mono files this directory used to hold went with D37, and `font-src 'self'` stays
because the library declares no font of its own. A missing asset therefore costs the look, never the page.
