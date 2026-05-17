import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const DATA_FILE = resolve(process.env.DATA_FILE ?? "/data/pantry.json");

type Status = "shopping" | "pantry";

type Item = {
  name: string;
  status: Status;
  quantity?: number;
  unit?: string;
  note?: string;
  added_at: string;
  purchased_at?: string;
};

type State = { items: Item[] };

async function load(): Promise<State> {
  if (!existsSync(DATA_FILE)) return { items: [] };
  try {
    const raw = JSON.parse(await readFile(DATA_FILE, "utf8")) as State;
    // Light migration: if a legacy item has no status, treat it as pantry.
    raw.items = (raw.items ?? []).map((i) => ({ ...i, status: i.status ?? "pantry" }));
    return raw;
  } catch {
    return { items: [] };
  }
}

async function save(state: State): Promise<void> {
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(state, null, 2));
}

function norm(name: string): string {
  return name.trim().toLowerCase();
}

function upsert(state: State, item: Item): void {
  const key = norm(item.name);
  state.items = state.items.filter((i) => norm(i.name) !== key).concat(item);
}

function parseBearers(): Set<string> {
  const list = process.env.MCP_BEARERS ?? process.env.MCP_BEARER ?? "";
  return new Set(list.split(",").map((s) => s.trim()).filter(Boolean));
}

function checkBearer(req: FastifyRequest, accepted: Set<string>): boolean {
  const h = req.headers.authorization;
  if (typeof h !== "string") return false;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m !== null && accepted.has(m[1]);
}

function buildMcp(): McpServer {
  const server = new McpServer(
    { name: "pantry", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );

  // --- reads ----------------------------------------------------------------

  server.tool(
    "list_pantry",
    "List every item the user currently HAS on hand (status=pantry). Returns JSON array of {name, quantity?, unit?, note?, added_at, purchased_at?}. Use before suggesting recipes or proposing a shopping list.",
    {},
    async () => {
      const { items } = await load();
      const pantry = items.filter((i) => i.status === "pantry");
      return { content: [{ type: "text", text: JSON.stringify(pantry, null, 2) }] };
    },
  );

  server.tool(
    "list_shopping",
    "List every item on the user's shopping list (status=shopping) — things they want but haven't bought yet. Use before adding duplicate items, and to remind the user what to grab at the store.",
    {},
    async () => {
      const { items } = await load();
      const shopping = items.filter((i) => i.status === "shopping");
      return { content: [{ type: "text", text: JSON.stringify(shopping, null, 2) }] };
    },
  );

  // --- writes: add ----------------------------------------------------------

  server.tool(
    "add_to_shopping",
    "Add an item to the user's shopping list (they don't have it yet, want to buy). If the same name is already on either list this REPLACES it — so you can update a quantity by calling this again. The item starts with status=shopping.",
    {
      name: z.string().min(1).describe("ingredient name, singular lowercase (e.g. 'tomato', 'chicken breast')"),
      quantity: z.number().positive().optional(),
      unit: z.string().optional().describe("e.g. 'g', 'kg', 'whole', 'cans'"),
      note: z.string().optional(),
    },
    async ({ name, quantity, unit, note }) => {
      const state = await load();
      const item: Item = {
        name: norm(name),
        status: "shopping",
        quantity,
        unit,
        note,
        added_at: new Date().toISOString(),
      };
      upsert(state, item);
      await save(state);
      return { content: [{ type: "text", text: `→ shopping: ${JSON.stringify(item)}` }] };
    },
  );

  server.tool(
    "add_to_pantry",
    "Add an item DIRECTLY to the pantry — the user already has it and just wants to track it (skip the shopping step). Use when the user says 'I have X' or 'I just bought Y, log it'.",
    {
      name: z.string().min(1),
      quantity: z.number().positive().optional(),
      unit: z.string().optional(),
      note: z.string().optional(),
    },
    async ({ name, quantity, unit, note }) => {
      const state = await load();
      const now = new Date().toISOString();
      const item: Item = {
        name: norm(name),
        status: "pantry",
        quantity,
        unit,
        note,
        added_at: now,
        purchased_at: now,
      };
      upsert(state, item);
      await save(state);
      return { content: [{ type: "text", text: `→ pantry: ${JSON.stringify(item)}` }] };
    },
  );

  // --- state transition -----------------------------------------------------

  server.tool(
    "mark_purchased",
    "Move an item from the shopping list to the pantry — the user has bought it. If they bought multiple items in one trip, call this once per item. Returns the updated item.",
    {
      name: z.string().min(1).describe("ingredient name to mark as purchased"),
    },
    async ({ name }) => {
      const state = await load();
      const key = norm(name);
      const item = state.items.find((i) => norm(i.name) === key);
      if (!item) {
        return { content: [{ type: "text", text: `no item named ${name} on either list — use add_to_pantry if they bought something new` }] };
      }
      if (item.status === "pantry") {
        return { content: [{ type: "text", text: `${name} is already in the pantry` }] };
      }
      item.status = "pantry";
      item.purchased_at = new Date().toISOString();
      await save(state);
      return { content: [{ type: "text", text: `marked ${name} as purchased — now in pantry` }] };
    },
  );

  // --- removes --------------------------------------------------------------

  server.tool(
    "remove_from_shopping",
    "Drop an item from the shopping list without buying it (user changed their mind, or you suggested it speculatively). Returns whether anything was removed.",
    { name: z.string().min(1) },
    async ({ name }) => {
      const state = await load();
      const key = norm(name);
      const before = state.items.length;
      state.items = state.items.filter((i) => !(norm(i.name) === key && i.status === "shopping"));
      const removed = state.items.length < before;
      if (removed) await save(state);
      return { content: [{ type: "text", text: removed ? `removed ${name} from shopping list` : `${name} wasn't on the shopping list` }] };
    },
  );

  server.tool(
    "remove_from_pantry",
    "Remove an item from the pantry — they used it up, threw it out, or it expired. Returns whether anything was removed.",
    { name: z.string().min(1) },
    async ({ name }) => {
      const state = await load();
      const key = norm(name);
      const before = state.items.length;
      state.items = state.items.filter((i) => !(norm(i.name) === key && i.status === "pantry"));
      const removed = state.items.length < before;
      if (removed) await save(state);
      return { content: [{ type: "text", text: removed ? `removed ${name} from pantry` : `${name} wasn't in the pantry` }] };
    },
  );

  return server;
}

async function main(): Promise<void> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 4 * 1024 * 1024 });

  const accepted = parseBearers();
  if (accepted.size === 0) app.log.warn("no MCP bearers configured; /mcp will reject all requests");
  else app.log.info({ accepted: accepted.size }, "MCP auth configured");

  app.get("/health", async () => ({ ok: true }));

  // --- Public REST surface for the live UI (tailnet-only; no bearer auth) ---

  app.get("/api/state", async (_req, reply) => {
    const { items } = await load();
    reply.header("cache-control", "no-store");
    return {
      shopping: items.filter((i) => i.status === "shopping"),
      pantry:   items.filter((i) => i.status === "pantry"),
    };
  });

  // Add an item to either list (user-driven, mirrors the MCP add tools).
  app.post<{
    Body: { name?: string; status?: Status; quantity?: number; unit?: string; note?: string };
  }>("/api/items", async (req, reply) => {
    const { name, status = "shopping", quantity, unit, note } = req.body ?? {};
    if (!name || !name.trim()) return reply.code(400).send({ error: "name required" });
    if (status !== "shopping" && status !== "pantry") {
      return reply.code(400).send({ error: "status must be 'shopping' or 'pantry'" });
    }
    const state = await load();
    const now = new Date().toISOString();
    const item: Item = {
      name: norm(name),
      status,
      quantity,
      unit,
      note,
      added_at: now,
      ...(status === "pantry" ? { purchased_at: now } : {}),
    };
    upsert(state, item);
    await save(state);
    return reply.code(200).send({ ok: true, item });
  });

  // Mark an item as purchased (shopping → pantry).
  app.post<{ Params: { name: string } }>("/api/items/:name/purchase", async (req, reply) => {
    const state = await load();
    const key = norm(decodeURIComponent(req.params.name));
    const item = state.items.find((i) => norm(i.name) === key);
    if (!item) return reply.code(404).send({ error: "not found" });
    if (item.status === "pantry") return reply.code(200).send({ ok: true, item, noop: true });
    item.status = "pantry";
    item.purchased_at = new Date().toISOString();
    await save(state);
    return reply.code(200).send({ ok: true, item });
  });

  // Remove an item from either list.
  app.delete<{ Params: { name: string } }>("/api/items/:name", async (req, reply) => {
    const state = await load();
    const key = norm(decodeURIComponent(req.params.name));
    const before = state.items.length;
    state.items = state.items.filter((i) => norm(i.name) !== key);
    const removed = state.items.length < before;
    if (removed) await save(state);
    return reply.code(200).send({ ok: true, removed });
  });

  // Single-file live view. No auth — pantry is tailnet-only.
  app.get("/", async (_req, reply) => {
    reply.type("text/html").send(INDEX_HTML);
  });

  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, payload, done) => {
    try { done(null, payload.length > 0 ? JSON.parse(payload as string) : undefined); }
    catch (err) { done(err as Error, undefined); }
  });

  app.all("/mcp", async (req: FastifyRequest, reply: FastifyReply) => {
    if (accepted.size === 0 || !checkBearer(req, accepted)) {
      return reply.code(401).header("WWW-Authenticate", "Bearer").send({ error: "unauthorized" });
    }
    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      return reply.code(405).send({ error: "method not allowed" });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = buildMcp();
    reply.raw.on("close", () => { transport.close().catch(() => undefined); server.close().catch(() => undefined); });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
    reply.hijack();
  });

  const shutdown = async (sig: string) => {
    app.log.info({ sig }, "shutting down");
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: HOST, port: PORT });
}

main().catch((err) => { console.error(err); process.exit(1); });

const INDEX_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <meta name="theme-color" content="#ffffff" />
  <title>pantry</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E🧺%3C/text%3E%3C/svg%3E" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: 'Inter', system-ui, sans-serif; }
    h1, h2, h3 { font-family: 'Fraunces', Georgia, serif; letter-spacing: -0.02em; }
    .num { font-variant-numeric: tabular-nums; }
    .eyebrow { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 500; color: rgb(168 162 158); }
    .pulse-in { animation: pi 380ms ease-out; }
    @keyframes pi { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
    .pulse-out { animation: po 200ms ease-in forwards; }
    @keyframes po { to { opacity: 0; transform: translateX(8px); } }
    .iconbtn { width: 1.75rem; height: 1.75rem; border-radius: 9999px; display: inline-flex; align-items: center; justify-content: center; color: rgb(168 162 158); transition: all 140ms; }
    .iconbtn:hover { background: rgb(245 245 244); color: rgb(28 25 23); }
    .iconbtn.danger:hover { color: rgb(220 38 38); background: rgb(254 242 242); }
    .iconbtn.go:hover { color: rgb(217 119 6); background: rgb(255 251 235); }
  </style>
</head>
<body class="bg-stone-50 text-stone-900 antialiased">
  <div class="min-h-screen">
    <div class="sticky top-0 z-10">
      <div class="bg-white" style="height: env(safe-area-inset-top);"></div>
      <header class="border-b border-stone-200 bg-white/75 backdrop-blur">
        <div class="max-w-5xl mx-auto px-4 sm:px-6 py-3 sm:py-4 flex items-baseline justify-between gap-3">
          <h1 class="text-xl sm:text-2xl font-semibold tracking-tight text-stone-900">
            pantry<span class="text-amber-600">.</span>live
          </h1>
          <div class="text-xs text-stone-400 num"><span id="updated">just now</span></div>
        </div>
      </header>
    </div>

    <main class="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
      <p class="text-sm text-stone-500 mb-8 max-w-xl">
        Edit directly, or let your agent manage it via MCP — same data either way.
      </p>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <section>
          <div class="flex items-baseline justify-between mb-3">
            <h2 class="text-2xl">shopping</h2>
            <span class="eyebrow num" id="shopping-count">0</span>
          </div>
          <ul id="shopping" class="rounded-2xl border border-stone-200 bg-white divide-y divide-stone-100 min-h-[6rem] mb-2"></ul>
          <form data-add="shopping" class="flex items-center gap-2">
            <input
              name="name"
              placeholder="add to shopping…"
              class="flex-1 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-sm placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-300 focus:border-amber-300"
            />
            <button type="submit" class="rounded-full bg-stone-900 text-white px-3 py-1.5 text-xs font-medium hover:bg-stone-800 transition-colors">add</button>
          </form>
        </section>

        <section>
          <div class="flex items-baseline justify-between mb-3">
            <h2 class="text-2xl">pantry</h2>
            <span class="eyebrow num" id="pantry-count">0</span>
          </div>
          <ul id="pantry" class="rounded-2xl border border-stone-200 bg-white divide-y divide-stone-100 min-h-[6rem] mb-2"></ul>
          <form data-add="pantry" class="flex items-center gap-2">
            <input
              name="name"
              placeholder="add to pantry…"
              class="flex-1 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-sm placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-300 focus:border-amber-300"
            />
            <button type="submit" class="rounded-full bg-stone-900 text-white px-3 py-1.5 text-xs font-medium hover:bg-stone-800 transition-colors">add</button>
          </form>
        </section>
      </div>
    </main>
  </div>

  <script>
    const $ = (id) => document.getElementById(id);
    const ago = (iso) => {
      const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
      if (s < 60) return s + 's ago';
      if (s < 3600) return Math.floor(s/60) + 'm ago';
      if (s < 86400) return Math.floor(s/3600) + 'h ago';
      return Math.floor(s/86400) + 'd ago';
    };
    const esc = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

    const checkSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><polyline points="20 6 9 17 4 12"/></svg>';
    const xSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

    const fmt = (i) => {
      const parts = [];
      if (i.quantity != null) parts.push(i.quantity);
      if (i.unit) parts.push(esc(i.unit));
      const name = esc(i.name);
      const qty = parts.length ? '<span class="num text-xs text-stone-400 ml-2">' + parts.join(' ') + '</span>' : '';
      const note = i.note ? '<div class="text-[11px] text-stone-400 mt-0.5">' + esc(i.note) + '</div>' : '';
      const stamp = i.status === 'pantry' && i.purchased_at
        ? ago(i.purchased_at)
        : (i.added_at ? 'added ' + ago(i.added_at) : '');
      const tsHtml = stamp ? '<span class="text-[11px] text-stone-300 num">' + esc(stamp) + '</span>' : '';
      const purchaseBtn = i.status === 'shopping'
        ? '<button class="iconbtn go" title="mark purchased" data-act="purchase" data-name="' + encodeURIComponent(i.name) + '">' + checkSvg + '</button>'
        : '';
      const removeBtn = '<button class="iconbtn danger" title="remove" data-act="remove" data-name="' + encodeURIComponent(i.name) + '">' + xSvg + '</button>';
      return '<li class="px-4 py-3 text-sm pulse-in flex items-center gap-3" data-key="' + esc(i.name) + '">'
        + '<div class="flex-1 min-w-0">'
        +   '<div class="text-stone-900">' + name + qty + '</div>'
        +   note
        + '</div>'
        + tsHtml
        + purchaseBtn + removeBtn
        + '</li>';
    };
    const empty = (msg) => '<li class="px-4 py-6 text-sm text-stone-400 italic text-center">' + msg + '</li>';

    let prev = '';
    async function tick() {
      try {
        const r = await fetch('/api/state', { cache: 'no-store' });
        const d = await r.json();
        const sig = JSON.stringify(d);
        if (sig === prev) {
          // Refresh just the timestamps if state didn't change
          document.querySelectorAll('[data-ts]').forEach(el => el.textContent = ago(el.dataset.ts));
          return;
        }
        prev = sig;

        const sList = d.shopping.length
          ? d.shopping.map(fmt).join('')
          : empty('nothing to buy');
        const pList = d.pantry.length
          ? d.pantry.sort((a,b)=>a.name.localeCompare(b.name)).map(fmt).join('')
          : empty('pantry is empty');
        $('shopping').innerHTML = sList;
        $('pantry').innerHTML = pList;
        $('shopping-count').textContent = d.shopping.length + ' item' + (d.shopping.length === 1 ? '' : 's');
        $('pantry-count').textContent = d.pantry.length + ' item' + (d.pantry.length === 1 ? '' : 's');
        $('updated').textContent = 'updated ' + new Date().toLocaleTimeString();
      } catch (e) {
        $('updated').textContent = 'reconnecting…';
      }
    }

    // Per-item button actions (purchase / remove)
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const name = btn.dataset.name;
      const act = btn.dataset.act;
      const li = btn.closest('li');
      if (li) li.classList.add('pulse-out');
      try {
        if (act === 'purchase') {
          await fetch('/api/items/' + name + '/purchase', { method: 'POST' });
        } else if (act === 'remove') {
          await fetch('/api/items/' + name, { method: 'DELETE' });
        }
      } finally {
        prev = '';
        setTimeout(tick, 150);
      }
    });

    // Quick-add inputs (bottom of each column)
    document.querySelectorAll('form[data-add]').forEach(form => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = form.querySelector('input[name="name"]');
        const name = input.value.trim();
        if (!name) return;
        const status = form.dataset.add;
        input.disabled = true;
        try {
          await fetch('/api/items', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, status })
          });
          input.value = '';
          prev = '';
          tick();
        } finally {
          input.disabled = false;
          input.focus();
        }
      });
    });

    tick();
    setInterval(tick, 1500);
  </script>
</body>
</html>`;

