# Kilo Workbench

[English](README.md) | [简体中文](README.zh-CN.md)

A local, single-user web dashboard for your own machine: a **card wall** for folders, VS Code windows, `.bat` scripts, local HTML pages and notes — plus a built-in **read-only monitor** for Kilo sessions across all your projects.

- **Zero third-party dependencies** — pure Node.js built-in modules
- **Card wall** — open a folder, launch VS Code, run a `.bat`, open a local `.html`, keep notes, group cards
- **Two views** — compact stacked list (default) and grid, with an offline DP packing layout that leaves no holes
- **Built-in Kilo monitor** — real-time state of every project's session (active / review / idle) over SSE, with unread badges and desktop notifications
- **Read-only by design** — the monitor opens Kilo's SQLite database with `readOnly` + `PRAGMA query_only` and the server only listens on `127.0.0.1`

---

## Requirements

- **Node.js v22.5 or newer** (the monitor uses the built-in `node:sqlite` module; v24 recommended)
- Windows for the launcher scripts and the "open folder / run bat / open in VS Code" actions

On older Node versions the card wall still works — only the monitor view reports that `node:sqlite` is unavailable.

## Quick start

```bat
:: optional: create your own settings (built-in defaults are used otherwise)
copy config.example.json config.json

:: start the hidden background service
启动工作台.bat
```

Or from a terminal:

```bash
node server.js
```

Then open <http://localhost:7788>.

## Configuration

Settings are read with the following precedence (highest first):

1. **Environment variables** — `KILO_MON_DB`, `KILO_OPENCODE_DB`
2. **`config.json`** — your local settings (never committed)
3. **`config.example.json`** — the shipped template
4. **Built-in defaults**

Copy `config.example.json` to `config.json` and change what you need:

| Key | Default | Meaning |
|---|---|---|
| `port` | `7788` | HTTP port. If you change it, also update the URL inside `启动工作台.bat`. |
| `host` | `127.0.0.1` | Bind address. Keep it on loopback: this server can open folders and run `.bat` files. |
| `vscodeCommand` | `code` | Command used by the "VS Code" button. |
| `monitor.dbPath` | `""` | Path to `kilo.db`. Empty = `~/.local/share/kilo/kilo.db`. |
| `monitor.probeIntervalMs` | `1000` | Interval of the read-only `PRAGMA data_version` probe. |
| `monitor.snapshotDays` | `7` | Only sessions active within the last N days are shown. |
| `monitor.recentWindowSec` | `1800` | Only sessions active within N seconds get their last message role queried. |
| `monitor.maxSessionsPerProject` | `20` | Cap on sessions returned per project. |
| `monitor.heartbeatSec` | `30` | SSE heartbeat interval. |
| `monitor.errorCooldownSec` | `30` | Retry cooldown after a snapshot failure. |
| `monitor.pageCacheKb` | `-32000` | SQLite page cache cap (negative value = KiB). |
| `opencodeImport.dbPath` | `""` | Path to `opencode.db`. Empty = `~/.local/share/opencode/opencode.db`. |
| `opencodeImport.pathBlacklist` | `[]` | Paths to skip when importing projects from opencode. |
| `desktopLnkImport.sourceDirs` | `[]` | Folders containing `.lnk` shortcuts to import. |
| `desktopLnkImport.groupRules` | `[]` | Auto-grouping rules as `[[pathPrefix, groupName], ...]`. |

Arrays in `config.json` **replace** the arrays from the template (they are not concatenated).

## Data and privacy

- Card data lives in `data/projects.json` on your machine only, and is git-ignored.
- The monitor opens Kilo's database **read-only** and sets `PRAGMA query_only = 1`, so it physically cannot write to or corrupt it.
- The server binds to `127.0.0.1` only — it is not reachable from other devices on your network.

## Sample data

On first run, if `data/projects.json` does not exist, the app shows the sample cards from `data/projects.example.json` (they point at generic folders such as `C:\Users\Public`). As soon as you add or edit a card in the UI, your own `data/projects.json` is written — from then on your file always takes priority.

## Project structure

```text
.
├─ server.js                    # HTTP server: cards API, open/run actions, built-in monitor
├─ public/index.html            # the whole front-end (inline JS): card wall, context menu, views, monitor
├─ data/projects.json           # your card data (git-ignored, created on first save)
├─ data/projects.example.json   # sample cards, shown while projects.json does not exist
├─ config.json                  # your settings (git-ignored)
├─ config.example.json          # settings template
├─ import-opencode.js           # optional: import project folders from opencode's database
├─ import-desktop-links.js      # optional: import folders / .bat / .html from desktop shortcuts
├─ 启动工作台.bat                # start the service (hidden window)
├─ 关闭工作台.bat                # stop the service
├─ 导入opencode项目.bat          # run import-opencode.js
├─ 导入桌面快捷方式.bat           # run import-desktop-links.js
├─ AGENTS.md                    # notes for AI coding agents working on this repo
└─ CHANGELOG.md
```

## Optional importers

Both importers only **append** to `data/projects.json` and never overwrite cards you already have.

- `导入opencode项目.bat` — reads the distinct project directories from `opencode.db` and turns them into cards.
- `导入桌面快捷方式.bat` — reads `.lnk` shortcuts from `desktopLnkImport.sourceDirs` and turns the targets into cards (folders), or attaches them as `.bat` buttons / local HTML links on the card that owns that folder. Put your own source folders and grouping rules into `config.json` first.

## FAQ

- **"Port already in use"** — the service is probably already running. Just open <http://localhost:7788>.
- **`node:sqlite` unavailable** — upgrade to Node v22.5+ (v24 recommended). Until then the monitor view shows an error, while the card wall keeps working.
- **The folder window opens behind the browser** — that is Windows focus behaviour. It is intentional: focus-stealing workarounds caused worse side effects.
- **Batch files show garbled Chinese in some consoles** — the scripts are UTF-8 with `chcp 65001`; modern Windows Terminal renders them correctly.

## Development

```bash
node --check server.js
node server.js
```

Publishing (for maintainers):

```bash
git remote add origin https://github.com/AXIRYYYY/kilo-workbench.git
git push -u origin main
```

## License

[MIT](LICENSE)
