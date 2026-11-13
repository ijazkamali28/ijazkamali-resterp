import type { Tx } from '../db/pool.js';

export interface AuditEntry {
  action: string;
  companyId?: string | null;
  branchId?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  deviceId?: string | null;
  entityTable?: string;
  entityId?: string | null;
  reasonCode?: string | null;
  reasonText?: string | null;
  approvedBy?: string | null;
  oldData?: unknown;
  newData?: unknown;
  ip?: string | null;
  metadata?: Record<string, unknown>;
}

/** Application-level audit (logins, approvals, exports, sensitive actions). Row changes are audited by DB triggers. */
export async function writeAudit(tx: Tx, e: AuditEntry) {
  await tx.query(
    `insert into audit.audit_log(company_id, branch_id, user_id, session_id, device_id, node_id, action, entity_table, entity_id,
       reason_code, reason_text, approved_by, old_data, new_data, ip_address, metadata)
     values ($1,$2,$3,$4,$5,app.node_id(),$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [e.companyId ?? null, e.branchId ?? null, e.userId ?? null, e.sessionId ?? null, e.deviceId ?? null, e.action,
     e.entityTable ?? null, e.entityId ?? null, e.reasonCode ?? null, e.reasonText ?? null, e.approvedBy ?? null,
     e.oldData === undefined ? null : JSON.stringify(e.oldData), e.newData === undefined ? null : JSON.stringify(e.newData),
     e.ip ?? null, JSON.stringify(e.metadata ?? {})],
  );
}
