import { query } from "../db";

/**
 * Write one row to the existing audit_log table.
 *
 * The same INSERT was previously copy-pasted into every route that needed it.
 * Existing inline INSERTs still work unchanged — this is just the shared path
 * for new admin actions.
 */
export async function audit(opts: {
  userId?:     string | null;
  action:      string;
  entityType?: string | null;
  entityId?:   string | null;
  metadata?:   unknown;
  ip?:         string | null;
}): Promise<void> {
  await query(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata, ip_addr)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      opts.userId ?? null,
      opts.action,
      opts.entityType ?? null,
      opts.entityId ?? null,
      opts.metadata === undefined ? null : JSON.stringify(opts.metadata),
      opts.ip ?? null,
    ]
  );
}
