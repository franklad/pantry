# pantry

A kitchen inventory app. Tracks items across two states: **shopping** (want to buy) and **pantry** (have on hand). Second reference implementation of the [BYOA skilled-pod contract](https://github.com/franklad/byoa) — proves that BYOA apps work fine *without* a human UI, then evolves to add one.

Live (tailnet-only): [pantry.machinecity.net](https://pantry.machinecity.net)

## What it does

Items have a lifecycle:

```
add_to_shopping ──► [shopping]  ──mark_purchased──►  [pantry] ──► remove_from_pantry
                       │                                ▲
                       │                                │
                       └── add_to_pantry (skip step) ───┘
```

Both **the user** (via the web UI) and **agents** (via MCP) can mutate the same state. Same JSON file, same code, two principals.

## What makes it interesting

Built initially with **no UI at all** — agent-only — to prove BYOA apps are first-class without a frontend. Then evolved to add a small live UI with the same actions exposed to humans. **Same data, two principals.**

The killer demo is cross-app composition with [gustus](https://github.com/franklad/gustus):

```
User: "What can I cook with what's in my pantry?"
Agent: pantry.list_pantry  →  gustus.list_recipes  →  gustus.get_recipe(...)
       picks shakshuka, identifies gaps in the user's pantry

User: "Add the missing ones to my shopping list."
Agent: pantry.add_to_shopping × N  (UI columns update live)

User: "I just got back from the store."
Agent: pantry.mark_purchased × N  (items migrate from shopping → pantry)

User: "Can I make it now?"
Agent: same query, different answer — pantry state has changed.
```

**Neither app knows the other exists.** The agent does every join. That's the platform thesis.

## Architecture

```
   Browser                MCP client (Hermes, etc.)
      │                            │
      ▼                            ▼
┌──────────────────────────────────────────┐
│  pantry (Fastify, ~300 LOC TypeScript)   │
│  ├ /                  live 2-col view    │
│  ├ /api/state         JSON for the UI    │
│  ├ /api/items         user mutations     │
│  └ /mcp               7 agent tools      │
└──────────────────┬───────────────────────┘
                   ▼
           pantry.json (PVC)
```

Single JSON file on a PVC. No database. ~300 lines of code total. Demonstrates how small an app can be while still being a first-class BYOA citizen.

## MCP tool surface (7 tools)

| Tool | Effect |
|---|---|
| `list_shopping` | items with status=shopping |
| `list_pantry` | items with status=pantry |
| `add_to_shopping({name, quantity?, unit?, note?})` | new shopping-list item |
| `add_to_pantry({name, quantity?, unit?, note?})` | direct-add (already bought) |
| `mark_purchased({name})` | shopping → pantry, stamps `purchased_at` |
| `remove_from_shopping({name})` | drop without buying |
| `remove_from_pantry({name})` | consumed / threw out |

## REST surface (UI uses these)

- `GET /api/state` — `{ shopping: [...], pantry: [...] }`
- `POST /api/items` — `{ name, status, quantity?, unit?, note? }`
- `POST /api/items/:name/purchase` — move shopping → pantry
- `DELETE /api/items/:name` — remove from either list

## Tech

- **Backend**: Node 20 + Fastify 5 + `@modelcontextprotocol/sdk` + zod
- **Frontend**: Single static HTML page served by the backend, Tailwind via CDN, polls `/api/state` every 1.5s
- **Storage**: JSON file on a PVC (no DB)
- **Container**: multi-stage Node alpine, ~50 MB

## Build + run

```bash
git clone https://github.com/franklad/pantry.git
cd pantry
docker build -t pantry:0.4.1 .
docker run -d --name pantry \
  -p 8080:8080 \
  -e MCP_BEARERS=$(openssl rand -hex 32) \
  -v pantry-data:/data \
  pantry:0.4.1
open http://localhost:8080
```

## Wire it to an agent

In Claude Desktop config:

```json
{
  "mcpServers": {
    "pantry": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://your-pantry-host/mcp",
        "--header",
        "Authorization: Bearer <your-MCP_BEARERS-value>"
      ]
    }
  }
}
```

Then in any chat: *"What's in my pantry?"*, *"Add eggs and milk to my shopping list"*, *"I bought everything on my list"*.

## Repo layout

```
server/index.ts          Fastify host + MCP server + REST + inline HTML (~300 LOC total)
Dockerfile               Multi-stage Node alpine
deploy/k8s/              k3s manifests (gitignored example bundle)
deploy/k8s/skill-md/     pantry.SKILL.md — the agent manifest
```

## Related

- [gustus](https://github.com/franklad/gustus) — recipe app, full UI + Postgres-backed. Cross-app composition with pantry is the platform demo.
- [byoa](https://github.com/franklad/byoa) — the platform spec + k8s deployment patterns + demo walkthrough.

## License

MIT.
