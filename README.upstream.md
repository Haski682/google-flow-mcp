# Google Flow Browser MCP

A local Model Context Protocol server that lets MCP clients such as Claude Code and Codex operate Google Flow through a visible Chrome or Edge window.

The server supports project tracking, assisted login, page inspection, reference uploads, generation preparation, explicit submission, progress recovery, media download, and FFprobe validation. It exposes 22 MCP tools and stores durable state in SQLite.

> This is an unofficial browser automation project. Google Flow does not expose a stable public API for this workflow. Website changes may require adapter updates.

## Safety model

- Every user runs the MCP server and browser locally.
- Users sign in to their own Google account in the visible browser window.
- The server never asks for, reads, types, stores, or repeats passwords, verification codes, recovery answers, or 2FA tokens.
- Credit-consuming generation requires an explicit confirmation before submission.
- Browser profiles, cookies, databases, generated media, and environment files are excluded from Git.
- Users are responsible for their Google Flow access, credits, regional availability, and compliance with applicable terms.

## Requirements

- Node.js 22.13 or newer
- pnpm
- Google Chrome or Microsoft Edge
- FFmpeg/FFprobe for local media validation
- A Google account with access to Google Flow

## One-command Claude Code install

macOS, Linux, or WSL:

```bash
claude mcp add --scope user google-flow -- npx -y google-flow-browser-mcp
```

Native Windows:

```powershell
claude mcp add --scope user google-flow -- cmd /c npx -y google-flow-browser-mcp
```

Confirm the registration, restart Claude Code, and open `/mcp`:

```bash
claude mcp get google-flow
```

## Install from source

```bash
git clone https://github.com/hitjcl/google-flow-mcp.git
cd google-flow-mcp
pnpm install --frozen-lockfile
pnpm test
```

### Claude Code

Register the built stdio server using the absolute path on your machine:

```bash
claude mcp add --scope user google-flow -- node "/absolute/path/google-flow-mcp/dist/src/index.js"
claude mcp get google-flow
```

On Windows PowerShell, for example:

```powershell
claude mcp add --scope user google-flow -- node "C:\path\to\google-flow-mcp\dist\src\index.js"
```

Restart Claude Code after registration. You can then ask:

> Use Google Flow to create a 10-second 9:16 video. Ask me to sign in and confirm credits before submitting, then download and validate the result locally.

### Other MCP clients

Use this stdio configuration and replace the path with an absolute local path:

```json
{
  "mcpServers": {
    "google-flow": {
      "command": "node",
      "args": ["/absolute/path/google-flow-mcp/dist/src/index.js"]
    }
  }
}
```

## Recommended workflow

1. `project_create`
2. `flow_start_login`
3. The user signs in and confirms membership and credits in the visible browser
4. `flow_confirm_login`
5. `flow_open_project` and `flow_inspect_page`
6. Optionally `flow_upload_reference` and `flow_bind_asset`
7. `flow_prepare_generation`
8. After explicit user approval, `flow_submit_generation`
9. `flow_wait_for_generation`
10. `flow_download_media`
11. `media_validate_local`

Generation polling is resumable. A timeout does not mark the job as failed, and successful media IDs are written to SQLite immediately.

## Data and configuration

Runtime data defaults to `~/.google-flow-creator/`:

- `browser-profile/` — local Chrome profile and login session
- `state.sqlite` — projects, jobs, attempts, assets, and media IDs
- `state.json` — optional legacy state imported on first use
- `downloads/` — downloaded media

Override locations with environment variables:

- `FLOW_BROWSER_EXECUTABLE`
- `FLOW_DATA_DIR`
- `FLOW_PROFILE_DIR`
- `FLOW_STATE_FILE`
- `FLOW_DATABASE_FILE`
- `FLOW_DOWNLOAD_DIR`

Never commit or share the runtime data directory because the browser profile can contain active login sessions.

## Development

```bash
pnpm run check
pnpm test
pnpm run health
```

Production maintenance commands:

- `pnpm run health` checks the runtime, database, browser, and FFprobe.
- `pnpm run backup` creates a consistent SQLite backup.
- `pnpm run smoke` performs a read/download smoke test using an existing completed video.

## License

MIT
