import type { DbContext } from '../db/pool.js';
import { forbidden } from '../lib/errors.js';

export interface Grant { roleCode: string; branchId: string | null; permissions: Set<string> }

export class AuthContext {
  constructor(
    public readonly userId: string,
    public readonly sessionId: string,
    public readonly homeCompanyId: string | null,
    /** effective tenant for this request (super admin may choose via X-Company-Id) */
    public readonly companyId: string | null,
    public readonly isPlatformAdmin: boolean,
    public readonly grants: Grant[],
    public readonly deviceId: string | null,
    public readonly requestId: string,
    public readonly ip: string | null,
    public readonly mustChangePassword = false,
  ) {}

  /** true if any grant covers all branches of the company */
  get allBranches(): boolean {
    return this.isPlatformAdmin || this.grants.some((g) => g.branchId === null);
  }

  get branchIds(): string[] {
    return [...new Set(this.grants.map((g) => g.branchId).filter((b): b is string => !!b))];
  }

  get permissions(): Set<string> {
    const s = new Set<string>();
    for (const g of this.grants) for (const p of g.permissions) s.add(p);
    return s;
  }

  /** Permission check. With branchId, only grants for that branch (or company-wide grants) count. */
  can(permission: string, branchId?: string | null): boolean {
    if (this.isPlatformAdmin) return true;
    return this.grants.some((g) => g.permissions.has(permission) && (g.branchId === null || !branchId || g.branchId === branchId));
  }

  require(permission: string, branchId?: string | null) {
    if (!this.can(permission, branchId)) {
      throw forbidden(`missing permission ${permission}${branchId ? ' for this branch' : ''}`, { permission, branchId });
    }
  }

  requireCompany(): string {
    if (!this.companyId) throw forbidden('a company context is required (super admin: send X-Company-Id)');
    return this.companyId;
  }

  db(extra: Partial<DbContext> = {}): DbContext {
    return {
      companyId: this.companyId,
      userId: this.userId,
      allBranches: this.allBranches,
      branchIds: this.branchIds,
      requestId: this.requestId,
      ...extra,
    };
  }
}
