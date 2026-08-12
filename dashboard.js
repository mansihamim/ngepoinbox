import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_LOG = 400;

const state = {
  child: null,
  running: false,
  starting: false,
  desired: true,
  restarts: 0,
  startedAt: null,
  lastExit: null,
  lastLogin: null,
  logs: [],
  restartTimer: null,
};

function pushLog(stream, text) {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const clean = line.replace(/\x1b\[[0-9;]*m/g, "");
    state.logs.push({
      t: new Date().toISOString(),
      stream,
      line: clean.slice(0, 2000),
    });
    const login = clean.match(/Login sebagai\s+(.+)/i);
    if (login) state.lastLogin = login[1].trim();
  }
  if (state.logs.length > MAX_LOG) state.logs.splice(0, state.logs.length - MAX_LOG);
}

function stopBot() {
  state.desired = false;
  if (state.restartTimer) {
    clearTimeout(state.restartTimer);
    state.restartTimer = null;
  }
  if (state.child && !state.child.killed) {
    state.child.kill("SIGTERM");
    setTimeout(() => {
      if (state.child && !state.child.killed) state.child.kill("SIGKILL");
    }, 4000);
  }
}

function startBot() {
  if (state.child) return;
  state.desired = true;
  state.starting = true;
  state.lastLogin = null;
  pushLog("sys", "Menyalakan kepo.js…");

  const child = spawn(process.execPath, ["kepo.js"], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  state.child = child;
  state.startedAt = Date.now();

  child.stdout.on("data", (buf) => pushLog("out", buf.toString()));
  child.stderr.on("data", (buf) => pushLog("err", buf.toString()));

  child.on("spawn", () => {
    state.running = true;
    state.starting = false;
    pushLog("sys", `Proses start (pid ${child.pid})`);
  });

  child.on("error", (err) => {
    pushLog("err", `Gagal spawn: ${err.message}`);
    state.starting = false;
    state.running = false;
    state.child = null;
  });

  child.on("exit", (code, signal) => {
    state.running = false;
    state.starting = false;
    state.child = null;
    state.lastExit = { code, signal, at: new Date().toISOString() };
    pushLog("sys", `Proses berhenti (code=${code} signal=${signal || "-"})`);

    if (!state.desired) return;
    state.restarts += 1;
    const delay = Math.min(15000, 1500 * state.restarts);
    pushLog("sys", `Auto-restart dalam ${delay}ms (ke-${state.restarts})`);
    state.restartTimer = setTimeout(() => {
      state.restartTimer = null;
      startBot();
    }, delay);
  });
}

function snapshot() {
  return {
    online: Boolean(state.running && state.child),
    starting: state.starting,
    desired: state.desired,
    pid: state.child?.pid ?? null,
    login: state.lastLogin,
    restarts: state.restarts,
    uptimeMs: state.startedAt && state.child ? Date.now() - state.startedAt : 0,
    lastExit: state.lastExit,
    logs: state.logs.slice(-120),
    now: Date.now(),
  };
}

function htmlPage() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>TALON · Bot Monitor</title>
<style>
  :root {
    --bg: #07080d;
    --panel: #10131c;
    --line: #232838;
    --text: #e8ecf7;
    --muted: #8b93a7;
    --ok: #3dd68c;
    --bad: #ff5d73;
    --warn: #f5c14a;
    --accent: #6d8bff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: ui-sans-serif, system-ui, Segoe UI, sans-serif;
    background:
      radial-gradient(900px 400px at 10% -10%, #1a2250 0%, transparent 55%),
      var(--bg);
    color: var(--text);
    min-height: 100vh;
  }
  .wrap { max-width: 980px; margin: 0 auto; padding: 28px 18px 48px; }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: .04em; }
  .sub { color: var(--muted); margin: 0 0 22px; font-size: 14px; }
  .grid { display: grid; grid-template-columns: 1.1fr .9fr; gap: 14px; }
  @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } }
  .card {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 16px;
    padding: 18px;
  }
  .status {
    display: flex; align-items: center; gap: 12px; margin-bottom: 16px;
  }
  .dot {
    width: 14px; height: 14px; border-radius: 50%;
    background: var(--bad);
    box-shadow: 0 0 0 6px rgba(255,93,115,.12);
  }
  .dot.on { background: var(--ok); box-shadow: 0 0 0 6px rgba(61,214,140,.14); }
  .dot.wait { background: var(--warn); box-shadow: 0 0 0 6px rgba(245,193,74,.14); }
  .name { font-size: 20px; font-weight: 700; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .kv { background: #0b0e16; border-radius: 10px; padding: 10px 12px; }
  .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
  .v { margin-top: 3px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; word-break: break-all; }
  .btns { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
  button {
    border: 0; border-radius: 10px; padding: 10px 14px; cursor: pointer;
    font-weight: 650; color: #fff;
  }
  .go { background: #1f8a55; }
  .stop { background: #b43348; }
  .rst { background: #3b4fd4; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  pre {
    margin: 0; height: 420px; overflow: auto;
    background: #07090f; border-radius: 12px; padding: 12px;
    font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: pre-wrap; word-break: break-word;
  }
  .out { color: #cfd6ea; }
  .err { color: #ff9aa8; }
  .sys { color: #f5c14a; }
  .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>TALON · Monitor</h1>
    <p class="sub">Pengawas proses <code>kepo.js</code> — auto-restart kalau bot mati.</p>
    <div class="grid">
      <section class="card">
        <div class="status">
          <div id="dot" class="dot"></div>
          <div>
            <div class="name" id="label">Memuat…</div>
            <div class="sub" id="login" style="margin:4px 0 0">—</div>
          </div>
        </div>
        <div class="meta">
          <div class="kv"><div class="k">PID</div><div class="v" id="pid">—</div></div>
          <div class="kv"><div class="k">Uptime</div><div class="v" id="uptime">—</div></div>
          <div class="kv"><div class="k">Auto-restart</div><div class="v" id="restarts">0</div></div>
          <div class="kv"><div class="k">Exit terakhir</div><div class="v" id="exit">—</div></div>
        </div>
        <div class="btns">
          <button class="go" id="start">Start</button>
          <button class="stop" id="stop">Stop</button>
          <button class="rst" id="restart">Restart</button>
        </div>
      </section>
      <section class="card">
        <div class="head"><strong>Log live</strong><span class="sub" id="clock" style="margin:0"></span></div>
        <pre id="log"></pre>
      </section>
    </div>
  </div>
<script>
function fmt(ms){
  if(!ms) return "0s";
  const s=Math.floor(ms/1000);
  const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=s%60;
  return [h&&h+"j", m&&m+"m", sec+"s"].filter(Boolean).join(" ");
}
async function act(path){
  await fetch(path,{method:"POST"});
  await tick();
}
document.getElementById("start").onclick=()=>act("/api/start");
document.getElementById("stop").onclick=()=>act("/api/stop");
document.getElementById("restart").onclick=()=>act("/api/restart");

async function tick(){
  const s = await (await fetch("/api/status")).json();
  const dot=document.getElementById("dot");
  const label=document.getElementById("label");
  dot.className="dot"+(s.starting?" wait":s.online?" on":"");
  label.textContent=s.starting?"Starting":s.online?"Online":"Offline";
  document.getElementById("login").textContent=s.login||"Belum login";
  document.getElementById("pid").textContent=s.pid??"—";
  document.getElementById("uptime").textContent=fmt(s.uptimeMs);
  document.getElementById("restarts").textContent=String(s.restarts);
  document.getElementById("exit").textContent=s.lastExit
    ? (s.lastExit.code??s.lastExit.signal)+" · "+new Date(s.lastExit.at).toLocaleTimeString("id-ID")
    : "—";
  document.getElementById("clock").textContent=new Date(s.now).toLocaleTimeString("id-ID");
  const log=document.getElementById("log");
  const atBottom=log.scrollTop+log.clientHeight>=log.scrollHeight-24;
  log.innerHTML=s.logs.map(l=>{
    const t=new Date(l.t).toLocaleTimeString("id-ID");
    return '<span class="'+l.stream+'">['+t+'] '+l.line.replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]))+"</span>";
  }).join("\\n");
  if(atBottom) log.scrollTop=log.scrollHeight;
}
tick();
setInterval(tick, 1500);
</script>
</body>
</html>`;
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const page = htmlPage();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/status") {
    json(res, 200, snapshot());
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/start") {
    startBot();
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/stop") {
    stopBot();
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/restart") {
    state.desired = true;
    if (state.child) {
      pushLog("sys", "Restart manual");
      state.child.kill("SIGTERM");
    } else {
      startBot();
    }
    json(res, 200, { ok: true });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Dashboard http://0.0.0.0:${PORT}`);
  startBot();
});

process.on("SIGINT", () => {
  stopBot();
  server.close(() => process.exit(0));
});
