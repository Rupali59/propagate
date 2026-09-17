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
import { queuePayload } from "../lib/report/queue.mjs";

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

export function page(token) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>propagate — the input surface</title>
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
nav{display:flex;gap:6px}
.tab{background:transparent;border:1px solid var(--line);color:var(--dim);font-weight:500;padding:4px 11px;font-size:12.5px}
.tab.on{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}
.loc{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--dim)}
.txt{margin:7px 0 0;font-size:13.5px}
/* THE DIFF IS THE EVIDENCE. The design review's first finding was that the
   system demands a judgement and gives you nothing to judge with. You approve
   this hunk, not a promise that something reasonable will happen. */
.diff{margin-top:9px;background:#0a0e13;border:1px solid var(--line);border-radius:6px;padding:9px 11px;
      font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;white-space:pre-wrap;word-break:break-all}
.diff .del{color:#ff7b72}
.diff .add{color:#3fb950}
.diff .hdr{color:var(--dim)}
.note{margin-top:7px;font-size:12px;color:#a1791f}
.trunc{color:#a1791f;font-size:12.5px;margin-bottom:10px}
</style></head><body>
<header><h1>propagate</h1><nav id="nav"><button class="tab on" data-v="queue">queue</button><button class="tab" data-v="issues">issues</button><button class="tab" data-v="todos">todos</button></nav><div class="sum" id="sum">loading…</div></header>
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
  if(!d.items.length){el.innerHTML='<div class="empty">Nothing actionable. Not the same as nothing scanned — '+d.expanded+' edges from '+d.declared+' declarations.</div>';return;}
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
// ── the register views ─────────────────────────────────────────────────
// EVERY WRITE IS PREVIEWED FIRST. The button says "preview", and only the diff
// it returns can be confirmed. A one-click write into hand-written prose is
// exactly the friction this should NOT remove.
function actionControls(it){
  const opts=[];
  if(it.actions.includes("issue-close")) opts.push('<option value="issue-close">close</option>');
  if(it.actions.includes("issue-severity")) opts.push('<option value="issue-severity">change severity</option>');
  if(it.actions.includes("todo-tick")) opts.push('<option value="todo-tick">tick done</option>');
  const sev='<select class="sev" style="display:none">'+["S0","S1","S2","S3","S4"].map(x=>'<option>'+x+'</option>').join('')+'</select>';
  return '<div class="act">'+
    '<select class="a">'+opts.join('')+'</select>'+sev+
    '<input class="r" placeholder="why (required, 12+ chars) — this goes into the file">'+
    '<button class="prev">preview</button>'+
  '</div>';
}
function renderRegister(d,kind){
  const el=document.getElementById("list");
  if(d.error){el.innerHTML='<div class="empty err">'+esc(d.error)+'</div>';return;}
  const items=kind==="issues"?d.issues:d.todos;
  const c=d.counts;
  document.getElementById("sum").innerHTML=
    '<b>'+items.length+'</b> '+kind+' with an action on their line · <b>'+c.noAction+
    '</b> items had none (already closed, or a status this surface does not edit)'+
    (c.unreadable?' · <b class="warn">'+c.unreadable+'</b> unreadable':'');
  if(!items.length){
    // Not "nothing to do" — say which question was asked.
    el.innerHTML='<div class="empty">No '+kind+' carry an action this surface can perform. '+
      c.noAction+' items were read and offered none.</div>';return;
  }
  const trunc=(kind==="issues"?c.issues>c.shownIssues:c.todos>c.shownTodos)
    ? '<div class="trunc">showing '+items.length+' of '+(kind==="issues"?c.issues:c.todos)+' — the rest are not hidden, just not on this page</div>' : '';
  el.innerHTML=trunc+items.map((it,i)=>
    '<div class="row" data-i="'+i+'">'+
      '<div class="hd">'+(it.id?'<span class="id">'+esc(it.id)+'</span>':'')+
        '<span class="loc">'+esc(it.short)+':'+it.line+'</span>'+
        (it.priority!=null?'<span class="hist">P'+it.priority+'</span>':'')+'</div>'+
      '<div class="txt">'+esc(it.text)+'</div>'+
      actionControls(it)+
      (it.noClose?'<div class="note">close not offered — '+esc(it.noClose)+'</div>':'')+
      '<div class="msg"></div></div>').join('');
  window.__items=items;
}
function diffHtml(diff){
  // DOUBLE-ESCAPED ON PURPOSE, and NO BACKTICKS IN THIS COMMENT. The whole page
  // is a template literal, so a single backslash-n here is interpreted when
  // page() RUNS: the browser receives a real newline inside a JS string
  // literal, which is a SyntaxError that kills the ENTIRE inline script. The
  // symptom is the header stuck on "loading..." forever, with a 200 on every
  // request and nothing in the network tab.
  //
  // A backtick in a comment closes the literal the same way -- which is how the
  // first version of THIS comment broke the file it was warning about.
  return '<div class="diff">'+diff.split("\\n").map(l=>{
    const cls=l.startsWith("+")?"add":l.startsWith("-")?"del":"hdr";
    return '<span class="'+cls+'">'+esc(l)+'</span>';
  }).join("\\n")+'</div>';
}
document.addEventListener("change",e=>{
  if(!e.target.classList.contains("a"))return;
  const row=e.target.closest(".row");
  row.querySelector(".sev").style.display=e.target.value==="issue-severity"?"":"none";
});
document.addEventListener("click",async e=>{
  // PREVIEW
  if(e.target.classList.contains("prev")){
    const row=e.target.closest(".row"), msg=row.querySelector(".msg");
    const it=window.__items[Number(row.dataset.i)];
    const body={action:row.querySelector(".a").value,file:it.file,line:it.line,current:it.raw,
                reason:row.querySelector(".r").value,severity:row.querySelector(".sev").value};
    msg.className="msg";msg.textContent="planning…";
    try{
      const res=await api("/api/register-preview",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
      if(!res.ok){msg.className="msg err";msg.textContent=res.error;return;}
      row.__plan={...body,next:res.next};
      msg.className="msg";
      msg.innerHTML=diffHtml(res.diff)+'<div class="act"><button class="confirm">write this</button><button class="cancel">cancel</button></div>';
    }catch(err){msg.className="msg err";msg.textContent=String(err);}
    return;
  }
  if(e.target.classList.contains("cancel")){
    const row=e.target.closest(".row");row.__plan=null;row.querySelector(".msg").innerHTML="";return;
  }
  // CONFIRM — sends back the EXACT line that was previewed.
  if(e.target.classList.contains("confirm")){
    const row=e.target.closest(".row"), msg=row.querySelector(".msg");
    e.target.disabled=true;
    try{
      const res=await api("/api/register-write",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(row.__plan)});
      if(res.ok){msg.className="msg ok";msg.textContent="written — "+res.file+":"+res.line;setTimeout(load,700);}
      else{msg.className="msg err";msg.textContent=res.error;}
    }catch(err){msg.className="msg err";msg.textContent=String(err);}
    return;
  }
  // tabs
  if(e.target.classList.contains("tab")){
    document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("on",t===e.target));
    VIEW=e.target.dataset.v;location.hash=VIEW;load();
  }
});
// The fragment arrives as "#/todos" from open-ui.sh (which is handed a ROUTE
// like /todos) and as "#todos" from a tab click, so the leading slash is
// stripped rather than one of the two producers being declared wrong. Without
// this a widget click on Todos silently lands on the queue tab -- no error, just
// the wrong page, which is the hardest kind of wrong to notice.
let VIEW=(location.hash||"#queue").slice(1).replace(/^[/]+/,"");
if(!["queue","issues","todos"].includes(VIEW)) VIEW="queue";
async function load(){
  document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("on",t.dataset.v===VIEW));
  try{
    if(VIEW==="queue") render(await api("/api/queue"));
    else renderRegister(await api("/api/registers"),VIEW);
  }catch(e){document.getElementById("sum").textContent="failed to load: "+e;}
}
load();
</script></body></html>`;
}


export async function uiCmd(argv = [], io = console) {
  const portArg = argv.indexOf("--port");
  const port = portArg >= 0 ? Number(argv[portArg + 1]) : 4599;
  const root = path.join(process.env.HOME ?? "", "Documents/GitHub/");

  const { appendEvent } = await import("../lib/edges/events.mjs");
  const { registerQueue } = await import("../lib/registers/queue.mjs");
  const { planEdit, applyEdit } = await import("../lib/registers/write.mjs");
  const { backlog } = await import("../lib/report/backlog.mjs");
  const { divergedGuard, buildEventPayload } = await import("../lib/edges/disposition.mjs");
  const { defaultDeps } = await import("../lib/report/queue.mjs");
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
      if (url.pathname === "/api/registers") {
        try { return send(200, registerQueue({ backlogFn: backlog })); }
        catch (err) { return send(500, { ok: false, error: String(err?.message ?? err) }); }
      }

      // PREVIEW — plans the edit and returns the hunk. Writes nothing.
      if (url.pathname === "/api/register-preview" && req.method === "POST") {
        let raw = "";
        for await (const c of req) raw += c;
        let body; try { body = JSON.parse(raw || "{}"); } catch { return send(400, { ok: false, error: "malformed JSON body" }); }
        const plan = planEdit(body);
        return send(plan.ok ? 200 : 400, plan);
      }

      // WRITE — the confirm step.
      //
      // IT RE-PLANS SERVER-SIDE AND REQUIRES THE RESULT TO MATCH what the
      // browser sends back. `next` arriving from a client is otherwise an
      // arbitrary line of markdown, and this endpoint would be a
      // write-anything-anywhere primitive behind a token. Re-planning makes the
      // browser's copy a CHECKSUM of the preview rather than its source.
      //
      // The planners are deterministic given (line, reason, date), so a
      // mismatch means the preview is genuinely stale — including the one real
      // edge case, a preview held across midnight. That refuses with a message
      // telling you to preview again, which is correct: the date in the file
      // would otherwise be the day you started reading, not the day you wrote.
      if (url.pathname === "/api/register-write" && req.method === "POST") {
        let raw = "";
        for await (const c of req) raw += c;
        let body; try { body = JSON.parse(raw || "{}"); } catch { return send(400, { ok: false, error: "malformed JSON body" }); }

        // THE PATH ALLOWLIST. Without it this endpoint writes an arbitrary line
        // into an arbitrary file — a much broader primitive than "edit a
        // register", and one that a token-gated loopback server should not
        // expose just because it is convenient. The allowed set is derived from
        // the SAME census the page was rendered from, so a file the surface
        // never offered cannot be written through it.
        const known = registerQueue({ backlogFn: backlog });
        const allowed = new Set([...(known.issues ?? []), ...(known.todos ?? [])].map((i) => i.file));
        if (!allowed.has(body.file)) {
          return send(403, { ok: false, error: `${body.file} is not a register this surface manages` });
        }

        const replan = planEdit(body);
        if (!replan.ok) return send(400, replan);
        if (replan.next !== body.next) {
          return send(409, {
            ok: false,
            error: "the preview no longer matches what this would write — preview again before confirming",
          });
        }
        const r = await applyEdit({ file: body.file, line: body.line, expected: body.current, next: replan.next });
        return send(r.ok ? 200 : 409, r);
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
