-- ============================================================
-- 004_endpoint_activity.sql — Endpoint activity visibility
--
-- Purely additive. No existing table, column, or constraint is
-- modified or dropped. Follows the same dual-path pattern as
-- 002_timescale.sql: TimescaleDB features are attempted inside
-- exception blocks so the migration also works on vanilla
-- PostgreSQL 14+.
--
-- Reversal (forward-only project, documented for completeness):
--   DROP TABLE IF EXISTS host_ports, host_processes,
--                        endpoint_events, collector_policy;
--   ALTER TABLE workstations
--     DROP COLUMN IF EXISTS agent_capabilities,
--     DROP COLUMN IF EXISTS agent_last_hello_at;
-- ============================================================

-- ------------------------------------------------------------
-- Agent capability advertisement (additive columns)
--
-- Old agents never send a "hello", so agent_capabilities stays
-- '[]' and the server never asks them for a new collector.
-- ------------------------------------------------------------
ALTER TABLE workstations
  ADD COLUMN IF NOT EXISTS agent_capabilities  JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS agent_last_hello_at TIMESTAMPTZ;

-- ------------------------------------------------------------
-- Collector policy
--
-- workstation_id IS NULL  → fleet-wide default for that collector
-- workstation_id IS NOT NULL → per-host override
--
-- Every collector defaults to enabled = FALSE. A collector only
-- runs when an admin turns it on AND the agent advertises it.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collector_policy (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workstation_id UUID REFERENCES workstations(id) ON DELETE CASCADE,
  collector      TEXT NOT NULL CHECK (collector IN ('process', 'ports')),
  enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  interval_sec   INT NOT NULL DEFAULT 60 CHECK (interval_sec BETWEEN 15 AND 3600),
  updated_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- NULLs compare as distinct in a plain UNIQUE, so use two partial indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_collector_policy_global
  ON collector_policy (collector) WHERE workstation_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_collector_policy_host
  ON collector_policy (workstation_id, collector) WHERE workstation_id IS NOT NULL;

-- Seed fleet-wide defaults — both OFF
INSERT INTO collector_policy (workstation_id, collector, enabled, interval_sec)
VALUES (NULL, 'process', FALSE, 60),
       (NULL, 'ports',   FALSE, 60)
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------
-- Endpoint events (append-only activity stream)
--
-- kind values emitted today:
--   process_start          a process appeared that was not in the previous sample
--   port_opened            a listening socket appeared
--   port_closed            a listening socket went away
--   agent_version_changed  agent reported a different version than last seen
--   agent_reconnected      agent re-established its WebSocket
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS endpoint_events (
  time           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  workstation_id UUID NOT NULL REFERENCES workstations(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  severity       TEXT NOT NULL DEFAULT 'info'
                   CHECK (severity IN ('info', 'warning', 'critical')),
  subject        TEXT,
  detail         JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_events_ws_time
  ON endpoint_events (workstation_id, time DESC);

CREATE INDEX IF NOT EXISTS idx_events_kind_time
  ON endpoint_events (kind, time DESC);

-- ------------------------------------------------------------
-- Current process inventory (latest sample per host, not a series)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS host_processes (
  workstation_id UUID NOT NULL REFERENCES workstations(id) ON DELETE CASCADE,
  pid            INT NOT NULL,
  name           TEXT NOT NULL,
  username       TEXT,
  exe            TEXT,
  cpu_pct        FLOAT DEFAULT 0,
  mem_pct        FLOAT DEFAULT 0,
  mem_rss_mb     FLOAT DEFAULT 0,
  io_read_mbs    FLOAT DEFAULT 0,
  io_write_mbs   FLOAT DEFAULT 0,
  started_at     TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workstation_id, pid)
);

CREATE INDEX IF NOT EXISTS idx_host_processes_cpu
  ON host_processes (workstation_id, cpu_pct DESC);

-- ------------------------------------------------------------
-- Current listening ports (latest sample per host)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS host_ports (
  workstation_id UUID NOT NULL REFERENCES workstations(id) ON DELETE CASCADE,
  proto          TEXT NOT NULL,
  laddr          TEXT NOT NULL,
  lport          INT  NOT NULL,
  pid            INT,
  process_name   TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workstation_id, proto, laddr, lport)
);

-- ------------------------------------------------------------
-- TimescaleDB enhancements for endpoint_events
-- (silently skipped on vanilla Postgres — the server also runs a
--  plain-SQL pruning job, so retention works either way)
-- ------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    PERFORM create_hypertable(
      'endpoint_events', 'time',
      chunk_time_interval => INTERVAL '7 days',
      if_not_exists => TRUE
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'TimescaleDB not available — endpoint_events stays a plain table';
    RETURN;
  END;

  BEGIN
    PERFORM add_retention_policy('endpoint_events', INTERVAL '30 days', if_not_exists => TRUE);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'endpoint_events retention policy skipped: %', SQLERRM;
  END;
END;
$$;
