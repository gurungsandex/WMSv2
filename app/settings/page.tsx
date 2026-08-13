"use client";
import { useEffect, useState, useCallback } from "react";
import { Shell } from "@/components/shell/Shell";
import { useAuth } from "@/lib/AuthContext";
import { auth, policy, exportUrl, type UserRow, type AuditRow, type PolicyResponse } from "@/lib/api";

function relTime(iso?: string | null) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

type Tab = "users" | "collectors" | "audit" | "password";

const TAB_LABEL: Record<Tab, string> = {
  users:      "Users",
  collectors: "Collectors",
  audit:      "Audit Log",
  password:   "Change Password",
};

export default function SettingsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [tab, setTab] = useState<Tab>(isAdmin ? "users" : "password");

  const tabs: Tab[] = isAdmin
    ? ["users", "collectors", "audit", "password"]
    : ["collectors", "password"];

  return (
    <Shell title="Settings" subtitle="User management, collectors, audit log, and account">
      <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>

        {/* Tab bar */}
        <div style={{ display: "flex", gap: 6, borderBottom: "1px solid var(--border)", paddingBottom: 0 }}>
          {tabs.map((t) => (
            <button key={t} onClick={() => setTab(t)}
              style={{
                padding: "8px 18px", borderRadius: "6px 6px 0 0", border: "1px solid",
                borderBottom: "none",
                borderColor: tab === t ? "var(--border)" : "transparent",
                background: tab === t ? "var(--card)" : "transparent",
                color: tab === t ? "var(--text)" : "var(--text-dim)",
                fontSize: 13, cursor: "pointer",
                marginBottom: -1,
              }}>
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>

        {tab === "users"      && <UsersPanel />}
        {tab === "collectors" && <CollectorsPanel isAdmin={isAdmin} />}
        {tab === "audit"      && <AuditPanel />}
        {tab === "password"   && <PasswordPanel />}
      </div>
    </Shell>
  );
}

// ── Collectors panel ──────────────────────────────────────────────────────────

const COLLECTOR_META: Record<string, { label: string; blurb: string; cost: string }> = {
  process: {
    label: "Process inventory",
    blurb: "Top processes by CPU, memory and I/O, plus an event when a new process appears. Records process name, executable path, owner and PID — never command-line arguments.",
    cost:  "measured ~0.15 ms per process per sample (~15 ms on a 100-process host); a few KB per sample.",
  },
  ports: {
    label: "Listening ports",
    blurb: "Listening TCP/UDP sockets attributed to the owning process, plus an event when a port opens or closes.",
    cost:  "measured ~3 ms per sample on a lightly loaded host; scales with open file descriptors.",
  },
};

function CollectorsPanel({ isAdmin }: { isAdmin: boolean }) {
  const [data, setData]       = useState<PolicyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState<string | null>(null);
  const [err, setErr]         = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await policy.list()); }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : "Failed to load"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function toggle(collector: string, enabled: boolean, intervalSec: number) {
    setSaving(collector);
    setErr("");
    try {
      await policy.set({ collector, enabled, interval_sec: intervalSec, workstation_id: null });
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(null);
    }
  }

  const globals = (data?.rows ?? []).filter((r) => r.workstation_id === null);
  const overrides = (data?.rows ?? []).filter((r) => r.workstation_id !== null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      <div style={{
        padding: "11px 14px", borderRadius: 8, fontSize: 12.5, lineHeight: 1.6,
        background: "var(--card-2)", border: "1px solid var(--border)", color: "var(--text-dim)",
      }}>
        Collectors gather endpoint activity beyond resource metrics. Every collector is
        <strong style={{ color: "var(--text)" }}> off by default</strong> and only runs on
        hosts whose agent reports support for it. Turning one on takes effect immediately on
        connected agents and is recorded in the audit log.
      </div>

      {err && <div style={{ fontSize: 12, color: "var(--critical)" }}>{err}</div>}

      {loading ? (
        <div style={{ padding: 24, color: "var(--text-dim)", fontSize: 13 }}>Loading…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {(data?.collectors ?? []).map((c) => {
            const row  = globals.find((g) => g.collector === c);
            const meta = COLLECTOR_META[c] ?? { label: c, blurb: "", cost: "" };
            const on   = row?.enabled ?? false;
            const capable = data?.capableHosts?.[c] ?? 0;

            return (
              <div key={c} className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 5 }}>
                      <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)" }}>{meta.label}</span>
                      <span className="mono" style={{
                        fontSize: 10, padding: "1px 7px", borderRadius: 4,
                        background: on ? "rgba(158,227,79,0.10)" : "var(--card-2)",
                        color: on ? "var(--healthy)" : "var(--text-faint)",
                      }}>{on ? "ON" : "OFF"}</span>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.6 }}>{meta.blurb}</div>
                    <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 5 }}>
                      Agent cost: {meta.cost}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 3 }}>
                      {capable} enrolled {capable === 1 ? "agent supports" : "agents support"} this collector
                    </div>
                  </div>

                  {isAdmin && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 7, alignItems: "flex-end" }}>
                      <button
                        onClick={() => toggle(c, !on, row?.interval_sec ?? 60)}
                        disabled={saving === c}
                        style={{
                          padding: "7px 16px", borderRadius: 7, border: "none",
                          cursor: saving === c ? "not-allowed" : "pointer",
                          background: on ? "var(--card-2)" : "var(--info)",
                          color: on ? "var(--text-dim)" : "#04070d",
                          fontWeight: 700, fontSize: 12.5, whiteSpace: "nowrap",
                          boxShadow: on ? "inset 0 0 0 1px var(--border)" : "none",
                        }}>
                        {saving === c ? "…" : on ? "Disable" : "Enable"}
                      </button>
                      <label style={{ fontSize: 11, color: "var(--text-faint)", display: "flex", alignItems: "center", gap: 6 }}>
                        Every
                        <select
                          value={row?.interval_sec ?? 60}
                          onChange={(e) => toggle(c, on, parseInt(e.target.value))}
                          disabled={saving === c}
                          style={{
                            background: "var(--bg-2)", border: "1px solid var(--border)",
                            borderRadius: 6, padding: "3px 7px", color: "var(--text)",
                            fontSize: 11, cursor: "pointer",
                          }}>
                          {[30, 60, 120, 300, 900].map((s) => (
                            <option key={s} value={s}>{s < 60 ? `${s}s` : `${s / 60}m`}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Per-host overrides */}
      {overrides.length > 0 && (
        <div className="card" style={{ overflow: "auto" }}>
          <div className="card-head"><div className="card-title">Per-host overrides</div></div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                {["Host", "Collector", "State", "Interval", ""].map((h) => (
                  <th key={h} style={{ padding: "8px 14px", textAlign: "left", color: "var(--text-dim)", fontWeight: 500, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {overrides.map((o) => (
                <tr key={`${o.workstation_id}-${o.collector}`} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "9px 14px", color: "var(--text)" }}>{o.hostname ?? "—"}</td>
                  <td style={{ padding: "9px 14px", color: "var(--text-dim)" }}>{o.collector}</td>
                  <td style={{ padding: "9px 14px", color: o.enabled ? "var(--healthy)" : "var(--text-faint)" }}>
                    {o.enabled ? "Enabled" : "Disabled"}
                  </td>
                  <td style={{ padding: "9px 14px", fontFamily: "var(--font-mono)", fontSize: 11 }}>{o.interval_sec}s</td>
                  <td style={{ padding: "9px 14px" }}>
                    {isAdmin && (
                      <button
                        onClick={async () => {
                          await policy.clearOverride(o.workstation_id!, o.collector);
                          await load();
                        }}
                        style={{ fontSize: 11, color: "var(--info)", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                        Reset to default
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Exports */}
      <div className="card">
        <div className="card-head"><div className="card-title">Export data</div></div>
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 12, lineHeight: 1.6 }}>
          Download fleet-wide snapshots for investigation or offline analysis.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(["events", "processes", "ports", "alerts"] as const).map((d) => (
            <a key={d} href={exportUrl(d, "csv")}
              style={{
                padding: "6px 13px", borderRadius: 7, border: "1px solid var(--border)",
                background: "var(--card-2)", color: "var(--text)", fontSize: 12,
                textDecoration: "none", textTransform: "capitalize",
              }}>
              {d} CSV
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Users panel ───────────────────────────────────────────────────────────────

function UsersPanel() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [newEmail, setNewEmail]       = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole]         = useState("viewer");
  const [creating, setCreating]       = useState(false);
  const [createErr, setCreateErr]     = useState("");
  const [deleting, setDeleting]       = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setUsers(await auth.listUsers()); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setCreateErr("");
    setCreating(true);
    try {
      await auth.createUser({ email: newEmail, password: newPassword, role: newRole });
      setNewEmail(""); setNewPassword(""); setNewRole("viewer");
      await load();
    } catch (err: unknown) {
      setCreateErr(err instanceof Error ? err.message : "Failed to create user");
    } finally {
      setCreating(false);
    }
  }

  async function deleteUser(id: string) {
    if (!confirm("Delete this user?")) return;
    setDeleting(id);
    try {
      await auth.deleteUser(id);
      await load();
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* User table */}
      <div className="card" style={{ overflow: "auto" }}>
        <div className="card-head"><div className="card-title">Accounts</div></div>
        {loading ? (
          <div style={{ padding: 24, color: "var(--text-dim)", fontSize: 13 }}>Loading…</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                {["Email", "Role", "Created", "Last login", ""].map((h) => (
                  <th key={h} style={{ padding: "8px 14px", textAlign: "left", color: "var(--text-dim)", fontWeight: 500, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "10px 14px", color: "var(--text)", fontWeight: 500 }}>
                    {u.email}
                    {u.id === me?.id && (
                      <span style={{ marginLeft: 6, fontSize: 10, color: "var(--info)", background: "color-mix(in oklab,var(--info) 12%,transparent)", padding: "1px 6px", borderRadius: 4 }}>you</span>
                    )}
                  </td>
                  <td style={{ padding: "10px 14px" }}>
                    <span style={{
                      fontSize: 11, fontWeight: 600,
                      color: u.role === "admin" ? "var(--warning)" : "var(--text-dim)",
                      background: u.role === "admin" ? "rgba(255,176,32,0.10)" : "var(--card-2)",
                      padding: "2px 8px", borderRadius: 4, textTransform: "capitalize",
                    }}>{u.role}</span>
                  </td>
                  <td style={{ padding: "10px 14px", fontSize: 12, color: "var(--text-dim)" }}>{relTime(u.created_at)}</td>
                  <td style={{ padding: "10px 14px", fontSize: 12, color: "var(--text-dim)" }}>{relTime(u.last_login_at)}</td>
                  <td style={{ padding: "10px 14px" }}>
                    {u.id !== me?.id && (
                      <button
                        onClick={() => deleteUser(u.id)}
                        disabled={deleting === u.id}
                        style={{ fontSize: 11, color: "var(--critical)", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                        {deleting === u.id ? "…" : "Delete"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Create user form */}
      <div className="card" style={{ maxWidth: 480 }}>
        <div className="card-head"><div className="card-title">Add user</div></div>
        <form onSubmit={createUser} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <label className="label">Email</label>
            <input required type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)}
              placeholder="user@example.com"
              style={INPUT_STYLE} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <label className="label">Password</label>
            <input required type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Min 8 characters"
              style={INPUT_STYLE} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <label className="label">Role</label>
            <select value={newRole} onChange={(e) => setNewRole(e.target.value)}
              style={{ ...INPUT_STYLE, cursor: "pointer" }}>
              <option value="viewer">Viewer</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          {createErr && <div style={{ fontSize: 12, color: "var(--critical)" }}>{createErr}</div>}
          <button type="submit" disabled={creating}
            style={{ padding: "9px 18px", borderRadius: 7, border: "none", cursor: creating ? "not-allowed" : "pointer", background: "var(--info)", color: "#04070d", fontWeight: 700, fontSize: 13, opacity: creating ? 0.7 : 1 }}>
            {creating ? "Creating…" : "Create user"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Audit log panel ────────────────────────────────────────────────────────────

function AuditPanel() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await auth.auditLog(page);
      setRows(res.rows);
      setTotal(res.total);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.ceil(total / 50);

  return (
    <div className="card" style={{ overflow: "auto" }}>
      <div className="card-head">
        <div className="card-title">Audit log</div>
        <span className="label">{total} entries</span>
      </div>
      {loading ? (
        <div style={{ padding: 24, color: "var(--text-dim)", fontSize: 13 }}>Loading…</div>
      ) : (
        <>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                {["When", "User", "Action", "Entity", "IP"].map((h) => (
                  <th key={h} style={{ padding: "8px 14px", textAlign: "left", color: "var(--text-dim)", fontWeight: 500, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "9px 14px", color: "var(--text-dim)", whiteSpace: "nowrap" }}>{relTime(r.created_at)}</td>
                  <td style={{ padding: "9px 14px", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{r.email ?? "—"}</td>
                  <td style={{ padding: "9px 14px", color: "var(--text)", fontWeight: 500 }}>{r.action}</td>
                  <td style={{ padding: "9px 14px", color: "var(--text-dim)", fontSize: 11 }}>
                    {r.entity_type ? `${r.entity_type}` : ""}
                    {r.entity_id ? <span style={{ fontFamily: "var(--font-mono)", marginLeft: 4 }}>{r.entity_id.slice(0, 8)}…</span> : ""}
                  </td>
                  <td style={{ padding: "9px 14px", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-faint)" }}>{r.ip_addr ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {totalPages > 1 && (
            <div style={{ display: "flex", gap: 8, padding: "12px 14px", justifyContent: "flex-end", alignItems: "center", borderTop: "1px solid var(--border)" }}>
              <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Page {page} of {totalPages}</span>
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                style={PAGE_BTN}>← Prev</button>
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                style={PAGE_BTN}>Next →</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Change password panel ──────────────────────────────────────────────────────

function PasswordPanel() {
  const [current, setCurrent]   = useState("");
  const [next, setNext]         = useState("");
  const [confirm, setConfirm]   = useState("");
  const [saving, setSaving]     = useState(false);
  const [msg, setMsg]           = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (next !== confirm) { setMsg({ ok: false, text: "Passwords do not match" }); return; }
    if (next.length < 8) { setMsg({ ok: false, text: "Password must be at least 8 characters" }); return; }
    setSaving(true);
    try {
      await auth.changePassword(current, next);
      setMsg({ ok: true, text: "Password changed successfully." });
      setCurrent(""); setNext(""); setConfirm("");
    } catch (err: unknown) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Failed" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 420 }}>
      <div className="card-head"><div className="card-title">Change password</div></div>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {[
          { label: "Current password", value: current, set: setCurrent },
          { label: "New password",     value: next,    set: setNext },
          { label: "Confirm password", value: confirm, set: setConfirm },
        ].map(({ label, value, set }) => (
          <div key={label} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <label className="label">{label}</label>
            <input required type="password" value={value} onChange={(e) => set(e.target.value)}
              placeholder="••••••••" style={INPUT_STYLE} />
          </div>
        ))}
        {msg && (
          <div style={{
            padding: "9px 12px", borderRadius: 7, fontSize: 12,
            background: msg.ok ? "rgba(158,227,79,0.08)" : "rgba(255,77,125,0.08)",
            border: `1px solid ${msg.ok ? "rgba(158,227,79,0.2)" : "rgba(255,77,125,0.2)"}`,
            color: msg.ok ? "var(--healthy)" : "var(--critical)",
          }}>{msg.text}</div>
        )}
        <button type="submit" disabled={saving}
          style={{ padding: "9px 18px", borderRadius: 7, border: "none", cursor: saving ? "not-allowed" : "pointer", background: "var(--info)", color: "#04070d", fontWeight: 700, fontSize: 13, opacity: saving ? 0.7 : 1 }}>
          {saving ? "Saving…" : "Update password"}
        </button>
      </form>
    </div>
  );
}

// ── Shared styles ──────────────────────────────────────────────────────────────

const INPUT_STYLE: React.CSSProperties = {
  background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8,
  padding: "9px 12px", color: "var(--text)", fontSize: 13, outline: "none",
};

const PAGE_BTN: React.CSSProperties = {
  padding: "4px 12px", borderRadius: 6, border: "1px solid var(--border)",
  background: "var(--card)", color: "var(--text-dim)", fontSize: 12, cursor: "pointer",
};
