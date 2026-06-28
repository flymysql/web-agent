# AI Browser Agent

Chrome/Edge Manifest V3 extension with a cloud Agent backend. The extension provides controlled page tools; the backend handles planning, orchestration, long-running tasks, and safety.

## Architecture

```
User → Popup UI → Service Worker → Content Script → Page DOM
                      ↕ WebSocket
                 Agent Backend (Planner + Orchestrator + Scheduler)
```

## Quick Start

### 1. Install dependencies

```bash
npm install
npm run build
```

### 2. Start the backend

```bash
cp server/.env.example server/.env
# Optional: set OPENAI_API_KEY for LLM-powered planning
npm run dev:server
```

Backend runs at `http://localhost:3847`.

### 3. Load the extension

1. Open `chrome://extensions`
2. Enable Developer mode
3. Load unpacked → select **`chrome-extension`** folder (created by `npm run build`)

> Do **not** load the repo root `ai-browser-agent/` — it has no manifest. Use `chrome-extension/` or `extension/dist/`.

### 4. Use

1. Open any webpage
2. Click the extension icon
3. Describe your task (e.g. "Find all links on this page and summarize them")
4. Review the plan, start execution, pause/resume as needed

## Project Structure

- `shared/` — Message protocol, tool schemas, shared types
- `extension/` — Chrome MV3 extension (popup, service worker, content script)
- `server/` — Agent backend (planner, orchestrator, task store, scheduler, safety)

## Capabilities

- **Page understanding**: DOM summary, interactive elements, visible text
- **Page actions**: click, type, scroll, wait, read text (whitelist tools only)
- **Agent loop**: understand → plan → execute → summarize
- **Task runtime**: pause, resume, cancel, checkpoints, audit logs
- **Long tasks**: scheduler, loop tasks, reconnect after extension disconnect
- **Safety**: dangerous action confirmation, sensitive field masking, audit trail

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default 3847) |
| `OPENAI_API_KEY` | Optional; enables LLM planning. Without it, rule-based planner is used |
| `OPENAI_MODEL` | Model name (default `gpt-4o-mini`) |
