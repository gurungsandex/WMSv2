#!/usr/bin/env node
/**
 * End-to-end smoke test.
 *
 * Boots nothing itself — it expects a server already running against a
 * throwaway database:
 *
 *   DATABASE_URL=... npm run migrate
 *   DATABASE_URL=... npm run dev
 *   API_URL=http://127.0.0.1:4000 npm run test:smoke
 *
 * Covers the auth boundary, the agent protocol (including legacy agents), the
 * endpoint-activity collectors, and the agent bootstrap endpoints.
 */
import { WebSocket } from "ws";
import { createHmac } from "node:crypto";

const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o))
  .toString("base64url");

/**
 * Mint an HS256 JWT by hand, so the test can forge the *legacy* agent token
 * shape — one signed with the user secret — without pulling in a JWT library.
 */
function signHs256(payload, secret) {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(payload);
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const API = process.env.API_URL ?? "http://127.0.0.1:4000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "admin@wms.local";
const ADMIN_PASS  = process.env.SMOKE_ADMIN_PASS  ?? "changeme123";

let pass = 0, fail = 0;
const check = (cond, msg, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${msg}`); }
  else      { fail++; console.log(`  FAIL  ${msg}${extra ? ` — ${extra}` : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let adminCookie = "", viewerCookie = "";

async function req(path, opts = {}, cookie = adminCookie) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { "Content-Type": "application/json", cookie, ...(opts.headers ?? {}) },
  });
  const raw = await res.text();
  let body; try { body = JSON.parse(raw); } catch { body = raw; }
  return { status: res.status, body, raw, headers: res.headers };
}

async function login(email, password) {
  const r = await fetch(API + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return {
    status: r.status,
    cookie: (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; "),
  };
}

function connectAgent(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${API.replace(/^http/, "ws")}/ws/agent?token=${token}`);
    const received = [];
    ws.on("message", (d) => { try { received.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
    ws.on("open", () => resolve({ ws, received }));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("agent ws timeout")), 5000);
  });
}

async function enroll(hostname, agentVersion = "1.1.0") {
  const tok = await req("/api/enroll/token", {
    method: "POST", body: JSON.stringify({ hostname }),
  });
  const reg = await req("/api/enroll/register", {
    method: "POST",
    body: JSON.stringify({
      enrollment_token: tok.body.enrollment_token,
      hostname, os_name: "Test OS", os_short: "Test", os_family: "linux",
      cpu_model: "Test CPU", cpu_cores: 4, ram_total_gb: 8, agent_version: agentVersion,
    }),
  });
  return reg.body;
}

// ── 1. Auth ───────────────────────────────────────────────────────────────────
console.log("\n=== Auth ===");
const admin = await login(ADMIN_EMAIL, ADMIN_PASS);
check(admin.status === 200, "admin can log in", `status ${admin.status}`);
adminCookie = admin.cookie;
if (admin.status !== 200) { console.log("\nCannot continue without admin login.\n"); process.exit(1); }

const viewerEmail = `viewer+${Date.now()}@wms.local`;
await req("/api/auth/users", {
  method: "POST",
  body: JSON.stringify({ email: viewerEmail, password: "viewerpass123", role: "viewer" }),
});
const viewer = await login(viewerEmail, "viewerpass123");
check(viewer.status === 200, "viewer can log in", `status ${viewer.status}`);
viewerCookie = viewer.cookie;

// Reset fleet-wide collector defaults so the run is idempotent — a previous
// run enables a collector, and "off by default" must still be assertable.
for (const collector of ["process", "ports"]) {
  await req("/api/policy/collectors", {
    method: "PUT",
    body: JSON.stringify({ collector, enabled: false, interval_sec: 60 }),
  });
}

// ── 2. Agent credentials must not be user credentials ────────────────────────
console.log("\n=== Auth boundary: agent tokens are not user tokens ===");
const modern = await enroll(`smoke-modern-${Date.now()}`);
check(!!modern.agent_token, "agent enrolled and received a token");

const asAgent = (path) =>
  req(path, { headers: { Authorization: `Bearer ${modern.agent_token}` } }, "");

const USER_FACING = [
  "/api/workstations", "/api/workstations/fleet", "/api/alerts",
  "/api/activity/events", "/api/export/processes?format=json", "/api/auth/me",
];

// A current agent token is signed with AGENT_JWT_SECRET, so it is not even a
// valid user JWT — jwtVerify fails and the request is a 401.
for (const path of USER_FACING) {
  const r = await asAgent(path);
  check(r.status === 401 || r.status === 403,
    `agent token rejected on ${path}`, `got ${r.status}`);
}
const agentAdmin = await req("/api/policy/collectors", {
  method: "PUT",
  headers: { Authorization: `Bearer ${modern.agent_token}` },
  body: JSON.stringify({ collector: "process", enabled: true }),
}, "");
check(agentAdmin.status === 401 || agentAdmin.status === 403,
  "agent token rejected on admin route", `got ${agentAdmin.status}`);

// Defence in depth: a *legacy* agent token is signed with the user secret, so
// jwtVerify succeeds. It must still be refused because it declares
// type === "agent". This is the check that does not rely on key separation,
// and it is the regression guard for the original privilege-escalation bug.
if (process.env.JWT_SECRET) {
  const legacyAgentToken = signHs256(
    { sub: modern.workstation_id, type: "agent" },
    process.env.JWT_SECRET
  );
  for (const path of USER_FACING) {
    const r = await req(path, {
      headers: { Authorization: `Bearer ${legacyAgentToken}` },
    }, "");
    check(r.status === 403,
      `legacy agent token refused by type guard on ${path}`, `got ${r.status}`);
  }

  // Sanity check that the forging helper itself is sound: the same signer
  // producing a *user* token must be accepted, otherwise the assertions above
  // would pass for the wrong reason.
  const forgedUser = signHs256(
    { sub: "00000000-0000-0000-0000-000000000000", email: "x@y.z", role: "viewer" },
    process.env.JWT_SECRET
  );
  const forgedRes = await req("/api/workstations", {
    headers: { Authorization: `Bearer ${forgedUser}` },
  }, "");
  check(forgedRes.status === 200,
    "control: a user-shaped token from the same signer is accepted",
    `got ${forgedRes.status}`);
} else {
  console.log("  SKIP  legacy agent token checks (set JWT_SECRET to enable)");
}

const anon = await req("/api/workstations", {}, "");
check(anon.status === 401, "unauthenticated request rejected", `got ${anon.status}`);

// ── 3. RBAC ───────────────────────────────────────────────────────────────────
console.log("\n=== RBAC ===");
const viewerWrite = await req("/api/policy/collectors", {
  method: "PUT", body: JSON.stringify({ collector: "process", enabled: true }),
}, viewerCookie);
check(viewerWrite.status === 403, "viewer cannot change collector policy", `got ${viewerWrite.status}`);
const viewerRead = await req("/api/policy/collectors", {}, viewerCookie);
check(viewerRead.status === 200, "viewer can read collector policy", `got ${viewerRead.status}`);

// ── 4. Agent protocol ─────────────────────────────────────────────────────────
console.log("\n=== Agent protocol ===");
const legacy = await enroll(`smoke-legacy-${Date.now()}`, "1.0.0");
const legacySock = await connectAgent(legacy.agent_token);
legacySock.ws.send(JSON.stringify({
  cpu_usage: 33.3, cpu_temp: 50, cpu_per_core: [33], ram_used_pct: 44,
  disk_used_pct: 20, disk_read_mbs: 0, disk_write_mbs: 0, gpu_load: 0, gpu_temp: 0,
  net_eth_in: 0, net_eth_out: 0, net_down_mbps: 0, net_up_mbps: 0, uptime_sec: 100,
}));
await sleep(1200);
const legacyWs = await req(`/api/workstations/${legacy.workstation_id}`);
check(Math.abs(legacyWs.body.snap_cpu_usage - 33.3) < 0.01,
  "untyped metric from a pre-upgrade agent still ingests", `got ${legacyWs.body.snap_cpu_usage}`);
check(JSON.stringify(legacyWs.body.agent_capabilities) === "[]",
  "agent that sent no hello has no capabilities");
check(legacySock.received.filter((m) => m.type === "policy").length === 0,
  "no policy pushed to an agent that advertised nothing");

const modernSock = await connectAgent(modern.agent_token);
modernSock.ws.send(JSON.stringify({
  type: "hello", agent_version: "1.1.0", capabilities: ["process", "ports", "not_a_collector"],
}));
await sleep(1200);
const modernWs = await req(`/api/workstations/${modern.workstation_id}`);
check(JSON.stringify(modernWs.body.agent_capabilities) === '["process","ports"]',
  "unknown capabilities filtered", JSON.stringify(modernWs.body.agent_capabilities));
const pushed = modernSock.received.filter((m) => m.type === "policy");
check(pushed.length > 0, "policy pushed on hello");
check(pushed.at(-1)?.collectors?.process?.enabled === false,
  "collectors are off by default");

// ── 5. Collectors ─────────────────────────────────────────────────────────────
console.log("\n=== Collectors ===");
const before = modernSock.received.length;
const enable = await req("/api/policy/collectors", {
  method: "PUT",
  body: JSON.stringify({ collector: "process", enabled: true, interval_sec: 30 }),
});
check(enable.status === 200, "admin can enable a collector", `got ${enable.status}`);
await sleep(1000);
const repushed = modernSock.received.slice(before).filter((m) => m.type === "policy");
check(repushed.length > 0 && repushed[0].collectors.process.enabled === true,
  "policy change pushed to the connected agent");

modernSock.ws.send(JSON.stringify({
  type: "processes", total: 42,
  processes: [
    { pid: 1, name: "init",  username: "root", cpu_pct: 0.1, mem_rss_mb: 5 },
    { pid: 2, name: "brave", username: "u",    cpu_pct: 70.0, mem_rss_mb: 900 },
  ],
  new: [{ pid: 2, name: "brave", username: "u" }],
}));
modernSock.ws.send(JSON.stringify({
  type: "ports",
  ports:  [{ proto: "tcp", laddr: "0.0.0.0", lport: 22, pid: 1, process_name: "sshd" }],
  opened: [{ proto: "tcp", laddr: "0.0.0.0", lport: 31337, pid: 9, process_name: "nc" }],
}));
await sleep(1500);

const procs = await req(`/api/activity/${modern.workstation_id}/processes`);
check(procs.body.length === 2 && procs.body[0].name === "brave",
  "processes stored and sorted by CPU", JSON.stringify(procs.body.map((p) => p.name)));
const ports = await req(`/api/activity/${modern.workstation_id}/ports`);
check(ports.body.length === 1, "listening ports stored", `got ${ports.body.length}`);
const events = await req(`/api/activity/${modern.workstation_id}/events`);
check(events.body.some((e) => e.kind === "process_start" && e.subject === "brave"),
  "process_start event recorded");
check(events.body.some((e) => e.kind === "port_opened" && e.severity === "warning"),
  "port_opened event recorded as a warning");

// ── 6. Validation + export ────────────────────────────────────────────────────
console.log("\n=== Validation and export ===");
const badColl = await req("/api/policy/collectors", {
  method: "PUT", body: JSON.stringify({ collector: "keylogger", enabled: true }),
});
check(badColl.status === 400, "unknown collector rejected", `got ${badColl.status}`);
const badInterval = await req("/api/policy/collectors", {
  method: "PUT", body: JSON.stringify({ collector: "process", enabled: true, interval_sec: 1 }),
});
check(badInterval.status === 400, "out-of-range interval rejected", `got ${badInterval.status}`);

const csv = await req("/api/export/events?format=csv");
check(csv.status === 200 && csv.raw.split("\n")[0].includes("hostname"),
  "events CSV export has a header row");
check((await req("/api/export/nope")).status === 404, "unknown export dataset 404s");

// ── 7. Agent bootstrap endpoints ──────────────────────────────────────────────
console.log("\n=== Agent bootstrap endpoints ===");
for (const [path, needle] of [
  ["/install/linux",    "WMS_ENROLL_TOKEN"],
  ["/install/macos",    "WMS_ENROLL_TOKEN"],
  ["/install/linux.sh", "WMS_ENROLL_TOKEN"],
  ["/install/windows",  "WMS_ENROLL_TOKEN"],
]) {
  const r = await req(path, {}, "");
  check(r.status === 200 && r.raw.includes(needle),
    `${path} serves a script that reads the token from the environment`, `status ${r.status}`);
}
const q = await req("/q/abc123", {}, "");
check(q.status === 200 && q.raw.includes('WMS_TOKEN="abc123"'),
  "/q/:token embeds the token directly");
check((await req("/install/solaris", {}, "")).status === 404, "unknown platform 404s");

// ── 8. Existing surface unchanged ─────────────────────────────────────────────
console.log("\n=== Existing endpoints ===");
for (const path of [
  "/api/workstations", "/api/workstations/fleet", "/api/alerts",
  "/api/alerts/summary", "/api/enroll/list",
]) {
  check((await req(path)).status === 200, `${path} responds 200`);
}
check((await fetch(API + "/health")).status === 200, "/health responds 200");

legacySock.ws.close();
modernSock.ws.close();

console.log(`\n${"=".repeat(46)}\n  ${pass} passed, ${fail} failed\n${"=".repeat(46)}\n`);
process.exit(fail === 0 ? 0 : 1);
