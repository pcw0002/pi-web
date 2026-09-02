# Pi-Web

Browser UI for the [pi coding agent](https://pi.dev). Chat, files, terminal, git, and models in one local app.

This is a fork of [xing-shuyin/pi-web-ui](https://github.com/xing-shuyin/pi-web-ui). Run **this repo**, not `npx pi-web-ui` (that is the upstream package and a different process).

What this fork adds: a **Review** tab for line comments on the working-tree or branch diff. Submit writes `.local-review/` at the git toplevel. Pending comments show as a chat chip (Apply in chat / Mark applied / Dismiss). The agent can apply them with `local_review_pending` / `local_review_mark_applied`, or the `apply-local-review` skill.

For plugins, themes, system service, reverse proxy, and the rest of the upstream feature set, see the [pi-web-ui README](https://github.com/xing-shuyin/pi-web-ui#readme).

## Requirements

- Node.js ≥ 22.19
- A configured pi install (`~/.pi/agent`, at least one API key)

## How to run

```bash
git clone git@github.com:pcw0002/pi-web.git
cd pi-web
npm install
npm run dev          # Vite http://localhost:5173  →  server :8788
```

Stop with `Ctrl+C`.

Production build (listens on `:8787` by default):

```bash
npm run build && npm start
```

Useful env vars:

| Variable | Default | Role |
| --- | --- | --- |
| `PORT` | `8787` (`8788` in `npm run dev`) | HTTP port |
| `PI_WEB_CWD` | current directory | Agent workspace |
| `PI_WEB_DATA_DIR` | `~/.pi-web` | UI state, uploads, plugins |

The server binds loopback (`127.0.0.1`) unless you set `PI_WEB_HOST=0.0.0.0`.

## Review

1. Open the **Review** tab.
2. Comment on the working-tree diff (or branch vs base). Click a line, Shift-click or drag for a range, or comment on the whole file.
3. **Submit** writes an append-only folder under `<git-root>/.local-review/reviews/<id>/` (`review.json`, `REVIEW.md`, plus `index.json`). Status starts as `pending`.
4. From the chat chip: **Apply in chat** injects pending comments into the agent; **Mark applied** or **Dismiss** closes them without waiting on the tool.

`.local-review/` is gitignored. Do not hand-edit the JSON to change status.

## Develop

```bash
npm run typecheck
npm test
npm run check:protocol
```

Project conventions live in [`AGENTS.md`](AGENTS.md).

## License

[MIT](LICENSE), same as upstream [pi-web-ui](https://github.com/xing-shuyin/pi-web-ui).
