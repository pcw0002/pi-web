# Local Review — package split (sketch)

> Parked under `future-work/`. The live product is the pi-web Review tab.
> Pull this out only after that is stable and there is a clear want for a
> VS Code / Cursor extension. Not on the typecheck or test path.

The portable product is the **on-disk payload**, not this web app.

```
.local-review/
  index.json
  reviews/<id>/
    review.json
    REVIEW.md
```

Any coding agent that can read those files can apply comments. The Review tab is one host for *writing* them. This sketch is how to extract that so Cursor / Claude / a CLI do not have to run pi-web-ui.

**Status:** Parked in `future-work/packages/`. Contracts only. Implementation lives in `server/review/` and `web/src/`. Do not import this from the app or add it to typecheck.

## Target layout

```
packages/
  core/          @local-review/core     git + parse + artifacts + apply markdown
  ui/            @local-review/ui       ReviewDiffView + range/file comment helpers
  mcp/           @local-review/mcp      tool schemas wrapping core (no LLM)
  apply-skill    already at skills/apply-local-review + .cursor/skills/apply-local-review
```

Hosts (adapters, not libraries):

| Host | Comment UI | Inject into conversation |
| --- | --- | --- |
| **pi-web** (this app) | Review tab | `review_apply` → `session.prompt(applyPendingPrompt)` |
| **VS Code / Cursor** | Webview sidebar | Write files, then skill / MCP / clipboard. No guaranteed inject into the current Cursor thread. |
| **CLI** | Opens a local SPA, or `--print` markdown | None. User pastes or runs the skill. |
| **MCP** | None | Tools: `local_review_pending`, `local_review_mark_applied`, optional `local_review_submit` |
| **Skill** | None | Instructions only. Already works in Cursor and Claude Code. |

```
                    ┌──────────────────────────────┐
                    │  .local-review/  (contract)  │
                    └──────────────┬───────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                    │
           core                 apply skill            ui
         git/write              SKILL.md           DiffView
              │                    │                    │
              └─────────┬──────────┴─────────┬──────────┘
                        │                    │
                  ReviewStore          ReviewSession
                        │                    │
         pi-web · vscode · mcp · cli · (skill = apply only)
```

A skill cannot host the comment UI. Keep the skill as the apply half; put the view in `ui` plus a host adapter.

## What stays host-specific

- Wire protocol (`review_diff` / `review_submit` / `review_apply`) — pi-web only
- `ClientSession.reviewApply()` — pi-web `ApplySink`
- `ReviewPanel`, `ReviewChip`, i18n, `.review-*` CSS
- Agent tools registered on the pi SDK (`server/review/agent-tools.ts`)

## Current → future file map

| Today | Package |
| --- | --- |
| `server/review/types.ts` | `core` (source of truth; `protocol.ts` keeps re-exporting) |
| `server/review/parseDiff.ts` | `core` |
| `server/review/git.ts` | `core` |
| `server/review/review.ts` | `core` (markdown + index + write) |
| `server/review/handlers.ts` | `core` (`loadDiff` / `submitReview`) |
| `packages/core/src/host.ts` | `ReviewStore` + `ApplySink` |
| `web/src/review-range.ts` | `ui` |
| `web/src/review-line-key.ts` | `ui` |
| `web/src/components/ReviewDiffView.tsx` | `ui` (drop `useT`; take `ReviewCopy`) |
| `web/src/components/ReviewPanel.tsx` | **host** (pi-web `ReviewSession`) |
| `server/review/wire.ts` | **host** (pi-web WS) |
| `server/review/agent-tools.ts` | **host** (pi SDK); MCP clone in `packages/mcp` |
| `skills/apply-local-review/SKILL.md` | unchanged; copy into Cursor/Claude skill dirs |

## Host adapter contracts

Defined in TypeScript so the next extraction has a compile-checked shape:

- `packages/core/src/host.ts` — `ReviewStore` (files + git) and `ApplySink` (send prompt to *some* agent)
- `packages/ui/src/host.ts` — `ReviewSession` (what the panel calls) and `ReviewCopy` (i18n)
- `packages/mcp/src/tools.ts` — tool names + JSON schemas, same semantics as `agent-tools.ts`

## Extraction order (when we cut, not this sketch)

1. Move types / parseDiff / git / artifacts into `packages/core`. Server re-exports. Tests import core.
2. Move range helpers + `ReviewDiffView` into `packages/ui`. `ReviewPanel` stays here and implements `ReviewSession` over WebSocket.
3. VS Code extension: webview loads `ui`, extension host implements `ReviewStore` with `child_process` git (or import core in the extension Node side).
4. MCP server: thin wrap of `ReviewStore`. Cursor/Claude enable it for apply without the UI.
5. CLI: `npx local-review` serves the SPA or writes comments from stdin JSON.

Do not add a second on-disk format. Do not try to iframe the IDE. Do not ship the Review tab as a Cursor skill.

## Honest Cursor/Claude limits

- **Apply in Cursor today:** Save only in this app, then `@apply-local-review` (skill already in `.cursor/skills/`).
- **Comment UI in Cursor:** needs a VS Code webview (or open this app / the future CLI SPA in a browser). Skills and canvases cannot do GitHub-style line comments on a live diff.
- **Inject into the current Cursor chat:** there is no stable public API equivalent to `session.prompt()`. Plan for skill + MCP + optional clipboard/composer, not a silent push into the open thread.
