/**
 * ui.mjs — a window onto the disposition queue, with the write path gated.
 *
 * WHY IT EXISTS. The monitor notifies; until 2026-09-17 it said
 * `DRIFTED CLAUDE.md → CLAUDE.md`, which is the correct rendering of seven
 * different edges in this tree. That is fixed, but a notification is still a
 * pointer, not a workbench: there was nowhere to SEE the 44 actionable edges,
 * read both sides, and record a judgement.
 *
 * SECURITY MODEL, copied deliberately from `scripts/claude-queue-ui.py`, which
 * worked it out the hard way (its C4: a drive-by browser page can reach a plain
 * loopback server, so loopback alone is not a boundary):
 *
 *   - bind 127.0.0.1 only
 *   - a per-start random token, required on every /api/* call
 *   - Host must be loopback, Origin must be same-origin or absent
 *
 * THE WRITE PATH IS NOT REIMPLEMENTED HERE. Payload construction and the
 * DIVERGED guard come from `lib/edges/disposition.mjs`, shared with `verify`.
 * Two writers building the same event separately is N86's defect exactly — one
 * contract, two implementations, drifting apart unnoticed.
 *
 * REASON IS MANDATORY, which is stricter than the CLI. `validateEvent` requires
 * a reason only for `wontfix` and `baselined`. A button is a lower-friction
 * write than a typed command, so the friction is restored deliberately: N64
 * records 556 unexplained `wontfix_reason` rows from v1, and N85 records
 * templated reasoning across 15 edges in one batch. A disposition whose reason
 * is "ok" is not cheaper to produce than one with a real sentence, but it is
 * worth much less to the next reader.
 */

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";

const TOKEN = randomBytes(24).toString("hex");

/** Same-origin / loopback gate. Returns a refusal string, or null when allowed. */
export function guardRequest(req, token, port) {
  const host = String(req.headers.host ?? "");
  const hostname = host.split(":")[0];
  if (hostname !== "127.0.0.1" && hostname !== "localhost") return "non-loopback Host";
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try {
      const u = new URL(origin);
      ok = (u.hostname === "127.0.0.1" || u.hostname === "localhost") && String(u.port) === String(port);
    } catch { ok = false; }
    if (!ok) return "cross-origin request";
  }
  const url = new URL(req.url, `http://${host}`);
  if (url.searchParams.get("token") !== token) return "bad or missing token";
  return null;
}

/**
 * Validate a disposition request BEFORE anything is written.
 *
 * Every refusal names the field, because "invalid request" is a reader that
 * failed and could not say why (`rule:discernment-checks` §2).
 */
export function validateWrite({ edge_id, disposition, reason }, item) {
  if (!edge_id) return "edge_id is required";
  if (!item) return `no actionable edge ${edge_id} — it may have been disposed in another window; reload`;
  if (!disposition) return "disposition is required";
  if (!item.allowed.includes(disposition)) {
    return `${item.state} edges do not accept "${disposition}" — allowed: ${item.allowed.join(", ")}`;
  }
  const r = String(reason ?? "").trim();
  if (r.length < 12) {
    return "a reason of at least 12 characters is required — this UI is stricter than the CLI on purpose; a one-click write with no reason is how an append-only store fills with judgements nobody can audit";
  }
  return null;
}

const STATE_COLOUR = { DRIFTED: "#b45309", DIVERGED: "#b91c1c", REVERSED: "#6d28d9", UNMATCHED: "#374151" };

function page(token) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>propagate — disposition queue</title>
<style>
:root{--bg:#0b0d10;--card:#151a21;--line:#232b36;--fg:#e6edf3;--dim:#8b98a8;--acc:#2f81f7}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{padding:14px 20px;border-bottom:1px solid var(--line);display:flex;gap:18px;align-items:baseline;flex-wrap:wrap}
h1{font-size:15px;margin:0;font-weight:600}
.sum{color:var(--dim);font-size:12.5px}
.sum b{color:var(--fg)}
main{padding:16px 20px;max-width:1180px}
.row{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-bottom:10px}
.hd{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.st{font-size:11px;font-weight:700;letter-spacing:.04em;padding:2px 7px;border-radius:4px;color:#fff}
.id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dim)}
.pair{margin:8px 0 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;word-break:break-all}
.arr{color:var(--dim);margin:0 6px}
.why{color:var(--dim);font-size:12.5px;margin-top:6px;white-space:pre-wrap}
.hist{margin-top:6px;font-size:12px;color:var(--dim)}
.warn{color:#f0b429}
.act{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
select,input,button{font:inherit;background:#0e1319;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px 9px}
input{flex:1;min-width:260px}
button{background:var(--acc);border-color:var(--acc);color:#fff;cursor:pointer;font-weight:600}
button:disabled{opacity:.45;cursor:not-allowed}
.msg{margin-top:8px;font-size:12.5px;white-space:pre-wrap}
.err{color:#ff7b72}.ok{color:#3fb950}
.empty{color:var(--dim);padding:40px 0;text-align:center}
</style></head><body>
<header><h1>propagate — disposition queue</h1><div class="sum" id="sum">loading…</div></header>
<main id="list"></main>
<script>
const TOKEN=${JSON.stringify(token)};
const api=(p,o={})=>fetch(p+(p.includes("?")?"&":"?")+"token="+TOKEN,o).then(r=>r.json());
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const COL=${JSON.stringify(STATE_COLOUR)};
function histLine(it){
  if(it.judgedCount===0) return '<span class="hist">never judged</span>';
  const pct=Math.round(it.noiseRatio*100);
  const cls=it.noiseRatio>=0.5?"hist warn":"hist";
  const last=it.last?(" · last: "+esc(it.last.disposition)):"";
  return '<span class="'+cls+'">judged '+it.judgedCount+'× · '+pct+'% no-change-needed'+last+'</span>';
}
function render(d){
  const s=d.summary;
  document.getElementById("sum").innerHTML=
    '<b>'+s.total+'</b> actionable · '+Object.entries(s.byState).map(([k,v])=>v+' '+k).join(' · ')+
    ' · <b>'+s.neverJudged+'</b> never judged · <b>'+s.highNoise+'</b> mostly-no-op';
  const el=document.getElementById("list");
  if(!d.items.length){el.innerHTML='<div class="empty">Nothing actionable. Not the same as nothing declared — '+d.declared+' edges exist.</div>';return;}
  el.innerHTML=d.items.map(it=>
    '<div class="row" data-id="'+it.edge_id+'">'+
      '<div class="hd"><span class="st" style="background:'+(COL[it.state]||"#374151")+'">'+it.state+'</span>'+
      '<span class="id">'+it.edge_id+'</span>'+histLine(it)+'</div>'+
      '<div class="pair">'+esc(it.sourceShort)+'<span class="arr">→</span>'+esc(it.downstreamShort)+'</div>'+
      (it.why?'<div class="why">'+esc(it.why)+'</div>':'')+
      '<div class="act">'+
        '<select class="d">'+it.allowed.map(a=>'<option>'+a+'</option>').join('')+'</select>'+
        '<input class="r" placeholder="why this disposition is correct (required, 12+ chars)">'+
        '<button class="go">record</button>'+
      '</div><div class="msg"></div></div>').join('');
}
document.addEventListener("click",async e=>{
  if(!e.target.classList.contains("go"))return;
  const row=e.target.closest(".row"), msg=row.querySelector(".msg");
  const body={edge_id:row.dataset.id,disposition:row.querySelector(".d").value,reason:row.querySelector(".r").value};
  e.target.disabled=true;msg.className="msg";msg.textContent="writing…";
  try{
    const res=await api("/api/dispose",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    if(res.ok){msg.className="msg ok";msg.textContent="recorded — event "+res.event_id;setTimeout(load,700);}
    else{msg.className="msg err";msg.textContent=res.error;e.target.disabled=false;}
  }catch(err){msg.className="msg err";msg.textContent=String(err);e.target.disabled=false;}
});
async function load(){try{render(await api("/api/queue"));}catch(e){document.getElementById("sum").textContent="failed to load: "+e;}}
load();
</script></body></html>`;
}

/** Build the queue payload. Exported so a test can drive it without a socket. */
export async function queuePayload(opts = {}) {
  const { loadWorkspaces, reconcile } = opts.deps ?? (await defaultDeps());
  const { buildQueue, queueSummary, historyByEdge } = await import("../lib/report/queue.mjs");
  const workspaces = await loadWorkspaces();
  const { rows } = await reconcile(workspaces, {});
  const history = await historyByEdge();
  const items = buildQueue(rows, history, { root: opts.root });
  return { items, summary: queueSummary(items), declared: rows.length };
}

async function defaultDeps() {
  const { reconcile } = await import("../lib/edges/reconcile.mjs");
  // WORKSPACES is a resolved constant, not a function — `config.mjs` runs
  // discovery once at import. `verify` uses the same value for the same reason:
  // a UI that discovered its own set could disagree with the CLI about what the
  // graph even contains, which is the N86 shape (one question, two readers).
  const { WORKSPACES } = await import("../lib/core/config.mjs");
  return { reconcile, loadWorkspaces: async () => WORKSPACES };
}

export async function uiCmd(argv = [], io = console) {
  const portArg = argv.indexOf("--port");
  const port = portArg >= 0 ? Number(argv[portArg + 1]) : 4599;
  const root = path.join(process.env.HOME ?? "", "Documents/GitHub/");

  const { appendEvent } = await import("../lib/edges/events.mjs");
  const { divergedGuard, buildEventPayload } = await import("../lib/edges/disposition.mjs");
  const deps = await defaultDeps();

  const server = createServer(async (req, res) => {
    const send = (code, body, type = "application/json") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const url = new URL(req.url, `http://${req.headers.host ?? "127.0.0.1"}`);

    if (url.pathname === "/" && url.searchParams.get("token") === TOKEN) {
      return send(200, page(TOKEN), "text/html; charset=utf-8");
    }
    if (url.pathname.startsWith("/api/")) {
      const refusal = guardRequest(req, TOKEN, port);
      if (refusal) return send(403, { ok: false, error: refusal });

      if (url.pathname === "/api/queue") {
        try { return send(200, await queuePayload({ root, deps })); }
        catch (err) { return send(500, { ok: false, error: String(err?.message ?? err) }); }
      }

      if (url.pathname === "/api/dispose" && req.method === "POST") {
        let raw = "";
        for await (const c of req) raw += c;
        let body; try { body = JSON.parse(raw || "{}"); } catch { return send(400, { ok: false, error: "malformed JSON body" }); }

        const payloadNow = await queuePayload({ root, deps });
        const item = payloadNow.items.find((i) => i.edge_id === body.edge_id);
        const invalid = validateWrite(body, item);
        if (invalid) return send(400, { ok: false, error: invalid });

        // Re-derive the row, then re-run the SAME guard verify uses. The queue
        // snapshot the browser holds may be seconds old; the guard must run
        // against state read now, not against what the page was rendered from.
        const workspaces = await deps.loadWorkspaces();
        const { rows } = await deps.reconcile(workspaces, {});
        const row = rows.find((r) => r.edge_id === body.edge_id);
        if (!row) return send(409, { ok: false, error: "edge vanished between render and write — reload" });
        const guard = divergedGuard(row.state, body.disposition);
        if (guard) return send(409, { ok: false, error: guard });

        try {
          const stamped = await appendEvent(buildEventPayload(row, body.disposition, String(body.reason).trim(), `${process.env.USER || "ui"} (ui)`));
          return send(200, { ok: true, event_id: stamped.event_id });
        } catch (err) {
          return send(400, { ok: false, error: String(err?.message ?? err) });
        }
      }
      return send(404, { ok: false, error: "no such endpoint" });
    }
    return send(404, "not found", "text/plain");
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const link = `http://127.0.0.1:${port}/?token=${TOKEN}`;
  io.log(`propagate ui — ${link}`);
  io.log(`  loopback only, per-start token. Ctrl-C to stop.`);
  return { server, port, token: TOKEN, link };
}
