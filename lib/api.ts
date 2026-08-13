// Thin API client — reads NEXT_PUBLIC_API_URL at runtime, falls back to relative
const BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api";

async function req<T>(
  path: string,
  opts?: RequestInit
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
    ...opts,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(msg || String(res.status));
  }
  return res.json() as Promise<T>;
}

// ---------- types ----------

export interface DiscoveredHost {
  id: string;
  ip: string;
  mac?: string;
  hostname?: string;
  vendor?: string;
  open_ports?: number[];
  last_scanned: string;
  is_enrolled: boolean;
  workstation_id?: string;
  status?: string;
  ws_hostname?: string;
  dept?: string;
}

export interface ScanSession {
  id: string;
  cidr: string;
  started_at: string;
  completed_at?: string;
  host_count: number;
  status: "running" | "done" | "error";
  started_by_email?: string;
}

export interface EnrolledWorkstation {
  id: string;
  hostname: string;
  ip?: string;
  mac?: string;
  dept?: string;
  owner_name?: string;
  os_family?: string;
  os_name?: string;
  status: string;
  health_score: number;
  enrolled_at?: string;
  last_seen_at?: string;
  agent_version?: string;
  is_enrolled: boolean;
  // latest metric snapshot (populated after first agent ingest)
  snap_cpu_usage?:     number;
  snap_cpu_temp?:      number;
  snap_ram_used_pct?:  number;
  snap_disk_used_pct?: number;
  snap_disk_read_mbs?: number;
  snap_disk_write_mbs?:number;
  snap_gpu_load?:      number;
  snap_gpu_temp?:      number;
  snap_net_eth_in?:    number;
  snap_net_eth_out?:   number;
  snap_net_down_mbps?: number;
  snap_net_up_mbps?:   number;
  // extended fields from detailed endpoint
  uptime_sec?:         number;
  cpu_model?:          string;
  cpu_cores?:          number;
  ram_total_gb?:       number;
  health_factors?:     Array<{ label: string; delta: number; sev: string }>;
}

export interface EnrollTokenResponse {
  workstation_id: string;
  enrollment_token: string;
  install: {
    linux: string;
    macos: string;
    windows: string;
    url: string;
  };
}

export interface FleetStats {
  counts: { healthy: number; warning: number; critical: number; offline: number };
  total: number;
  avgCpu: number;
  avgRam: number;
  avgDisk: number;
  avgGpu: number;
  netIn: number;
  netOut: number;
}

// ---------- discovery ----------

export const discovery = {
  hosts: () => req<DiscoveredHost[]>("/discover/hosts"),
  sessions: () => req<ScanSession[]>("/discover/sessions"),
  session: (id: string) => req<ScanSession>(`/discover/sessions/${id}`),
  scan: (cidrs?: string[]) =>
    req<{ session_id: string; status: string }>("/discover", {
      method: "POST",
      body: JSON.stringify({ cidrs }),
    }),
};

// ---------- deploy ----------

export interface DeployParams {
  host_id?:      string;
  ip?:           string;
  ssh_user:      string;
  ssh_password?: string;
  ssh_key?:      string;
  ssh_port?:     number;
  hostname?:     string;
  dept?:         string;
  owner?:        string;
}

export const deploy = {
  // Returns a ReadableStream of plain-text log lines
  run: (params: DeployParams): Promise<Response> =>
    fetch((process.env.NEXT_PUBLIC_API_URL ?? "/api") + "/deploy", {
      method:      "POST",
      credentials: "include",
      headers:     { "Content-Type": "application/json" },
      body:        JSON.stringify(params),
    }),
};

// ---------- enrollment ----------

export const enrollment = {
  list: () => req<EnrolledWorkstation[]>("/enroll/list"),
  generateToken: (data: { hostname?: string; ip?: string; dept?: string; owner?: string }) =>
    req<EnrollTokenResponse>("/enroll/token", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  revoke: (id: string) =>
    req<{ ok: boolean }>(`/enroll/${id}`, { method: "DELETE" }),
};

// ---------- workstations ----------

export const workstations = {
  fleet: () => req<FleetStats>("/workstations/fleet"),
  list: (params?: Record<string, string>) => {
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return req<{ total: number; rows: EnrolledWorkstation[] }>(`/workstations${qs}`);
  },
  get: (id: string) => req<EnrolledWorkstation>(`/workstations/${id}`),
};

// ---------- auth / users ----------

export interface UserRow {
  id: string;
  email: string;
  role: "admin" | "viewer";
  created_at: string;
  last_login_at: string | null;
}

export interface AuditRow {
  id: string;
  email?: string;
  action: string;
  entity_type?: string;
  entity_id?: string;
  metadata?: string;
  ip_addr?: string;
  created_at: string;
}

export const auth = {
  me: () => req<{ id: string; email: string; role: string }>("/auth/me"),
  login: (email: string, password: string) =>
    req<{ ok: boolean; role: string; email: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () => req<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  listUsers: () => req<UserRow[]>("/auth/users"),
  createUser: (data: { email: string; password: string; role: string }) =>
    req<UserRow>("/auth/users", { method: "POST", body: JSON.stringify(data) }),
  deleteUser: (id: string) =>
    req<{ ok: boolean }>(`/auth/users/${id}`, { method: "DELETE" }),
  changePassword: (currentPassword: string, newPassword: string) =>
    req<{ ok: boolean }>("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  auditLog: (page = 1) =>
    req<{ total: number; rows: AuditRow[] }>(`/audit?page=${page}&limit=50`),
};

// ---------- alerts ----------

export interface AlertRow {
  id: string;
  workstation_id: string;
  hostname: string;
  dept?: string;
  metric: string;
  value?: string;
  threshold: string;
  severity: "critical" | "warning";
  action?: string;
  is_resolved: boolean;
  is_ack: boolean;
  ack_by?: string;
  started_at: string;
  resolved_at?: string;
  duration_min?: number;
}

export interface AlertSummary {
  activeCritical: number;
  activeWarning: number;
  acknowledged: number;
  resolved24h: number;
}

export const alerts = {
  list: (params?: Record<string, string>) => {
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return req<{ total: number; rows: AlertRow[] }>(`/alerts${qs}`);
  },
  summary: () => req<AlertSummary>("/alerts/summary"),
  ack: (ids: string[]) =>
    req<{ ok: boolean; count: number }>("/alerts/ack", {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),
};

// ---------- endpoint activity ----------

export interface ProcessRow {
  pid:           number;
  name:          string;
  username?:     string;
  exe?:          string;
  cpu_pct:       number;
  mem_pct:       number;
  mem_rss_mb:    number;
  io_read_mbs:   number;
  io_write_mbs:  number;
  started_at?:   string;
  updated_at:    string;
}

export interface PortRow {
  proto:         string;
  laddr:         string;
  lport:         number;
  pid?:          number;
  process_name?: string;
  updated_at:    string;
}

export interface EventRow {
  time:            string;
  kind:            string;
  severity:        "info" | "warning" | "critical";
  subject?:        string;
  detail?:         Record<string, unknown>;
  workstation_id?: string;
  hostname?:       string;
}

export const activity = {
  processes: (id: string, limit = 25) =>
    req<ProcessRow[]>(`/activity/${id}/processes?limit=${limit}`),
  ports: (id: string) => req<PortRow[]>(`/activity/${id}/ports`),
  events: (id: string, limit = 50) =>
    req<EventRow[]>(`/activity/${id}/events?limit=${limit}`),
  fleetEvents: (params?: Record<string, string>) => {
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return req<EventRow[]>(`/activity/events${qs}`);
  },
};

// ---------- collector policy ----------

export interface CollectorSetting {
  enabled:      boolean;
  interval_sec: number;
}

export interface PolicyRow {
  workstation_id: string | null;
  collector:      string;
  enabled:        boolean;
  interval_sec:   number;
  updated_at:     string;
  hostname:       string | null;
}

export interface PolicyResponse {
  collectors:   string[];
  rows:         PolicyRow[];
  capableHosts: Record<string, number>;
}

export const policy = {
  list: () => req<PolicyResponse>("/policy/collectors"),
  forHost: (id: string) =>
    req<{ effective: Record<string, CollectorSetting>; capabilities: string[] }>(
      `/policy/collectors/${id}`
    ),
  set: (data: {
    collector: string;
    enabled: boolean;
    interval_sec?: number;
    workstation_id?: string | null;
  }) =>
    req<{ ok: boolean }>("/policy/collectors", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  clearOverride: (workstationId: string, collector: string) =>
    req<{ ok: boolean }>(`/policy/collectors/${workstationId}/${collector}`, {
      method: "DELETE",
    }),
};

// ---------- export ----------

/** Build a download URL for a dataset export (CSV or JSON). */
export function exportUrl(
  dataset: "events" | "processes" | "ports" | "alerts",
  format: "csv" | "json" = "csv",
  workstationId?: string
): string {
  const base = process.env.NEXT_PUBLIC_API_URL ?? "/api";
  const qs = new URLSearchParams({ format });
  if (workstationId) qs.set("workstation_id", workstationId);
  return `${base}/export/${dataset}?${qs.toString()}`;
}
