import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTx } from '../../db/pool.js';
import { auth } from '../../plugins/auth.js';
import { registerCrud, idParam } from '../../lib/crud.js';
import { notFound, conflict, forbidden } from '../../lib/errors.js';
import { createCompany, createBranchDefaults } from './bootstrap.js';
import { writeAudit } from '../../lib/audit.js';
import { uuidv7 } from '../../lib/uuid.js';

const code = z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9_-]+$/, 'letters, digits, - and _ only');
const trn = z.string().regex(/^[0-9]{15}$/, 'UAE TRN must be 15 digits');

const companyCreate = z.object({
  code, legalName: z.string().trim().min(2).max(200), tradeName: z.string().trim().max(200).optional(),
  vatRegistrationNo: trn.optional(), baseCurrency: z.string().length(3).toUpperCase().optional(),
  timezone: z.string().max(64).optional(), pricesIncludeTax: z.boolean().optional(),
}).strict();

const companyUpdate = z.object({
  legalName: z.string().trim().min(2).max(200).optional(), tradeName: z.string().trim().max(200).nullable().optional(),
  vatRegistrationNo: trn.nullable().optional(), timezone: z.string().max(64).optional(),
  pricesIncludeTax: z.boolean().optional(), settings: z.record(z.string(), z.unknown()).optional(),
  rowVersion: z.number().int().positive(),
}).strict();

const branchFields = {
  name: z.string().trim().min(2).max(120),
  addressLine: z.string().max(300).nullable().optional(), city: z.string().max(80).nullable().optional(),
  emirate: z.enum(['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah']).nullable().optional(),
  phone: z.string().max(30).nullable().optional(), email: z.string().email().nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(), longitude: z.number().min(-180).max(180).nullable().optional(),
  timezone: z.string().max(64).nullable().optional(), vatRegistrationNo: trn.nullable().optional(),
  businessDayCutoff: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
};

export default async function orgRoutes(app: FastifyInstance) {
  // ---------------- companies
  app.get('/org/companies', async (req) => {
    const a = auth(req);
    if (a.isPlatformAdmin && !a.companyId) {
      return withTx({ system: true }, (tx) => tx.query('select * from org.companies order by code').then((r) => ({ data: r.rows })));
    }
    a.require('org.company.view');
    return withTx(a.db(), (tx) => tx.query('select * from org.companies').then((r) => ({ data: r.rows })));
  });

  app.post('/org/companies', async (req, reply) => {
    const a = auth(req);
    if (!a.isPlatformAdmin) throw forbidden('only the platform super admin can create companies');
    const body = companyCreate.parse(req.body);
    const id = await withTx({ system: true, userId: a.userId, requestId: a.requestId }, async (tx) => {
      const companyId = await createCompany(tx, body);
      await writeAudit(tx, { action: 'org.company.created', companyId, userId: a.userId, entityTable: 'org.companies', entityId: companyId, newData: body, ip: a.ip });
      return companyId;
    });
    reply.code(201);
    return withTx({ system: true }, (tx) => tx.query('select * from org.companies where id = $1', [id]).then((r) => r.rows[0]));
  });

  app.get('/org/companies/:id', async (req) => {
    const a = auth(req);
    const { id } = idParam.parse(req.params);
    a.require('org.company.view');
    const row = await withTx(a.db(), (tx) => tx.query('select * from org.companies where id = $1', [id]).then((r) => r.rows[0]));
    if (!row) throw notFound();
    return row;
  });

  app.patch('/org/companies/:id', async (req) => {
    const a = auth(req);
    const { id } = idParam.parse(req.params);
    a.require('org.company.manage');
    const { rowVersion, ...b } = companyUpdate.parse(req.body);
    return withTx(a.db(), async (tx) => {
      const cur = (await tx.query('select * from org.companies where id = $1 for update', [id])).rows[0];
      if (!cur) throw notFound();
      if (Number(cur.row_version) !== rowVersion) throw conflict('record was modified by someone else; reload and retry');
      const r = await tx.query(
        `update org.companies set legal_name = coalesce($2, legal_name), trade_name = case when $3::boolean then $4 else trade_name end,
           vat_registration_no = case when $5::boolean then $6 else vat_registration_no end, timezone = coalesce($7, timezone),
           prices_include_tax = coalesce($8, prices_include_tax), settings = coalesce($9::jsonb, settings)
         where id = $1 returning *`,
        [id, b.legalName ?? null, b.tradeName !== undefined, b.tradeName ?? null, b.vatRegistrationNo !== undefined, b.vatRegistrationNo ?? null,
         b.timezone ?? null, b.pricesIncludeTax ?? null, b.settings ? JSON.stringify(b.settings) : null]);
      return r.rows[0];
    });
  });

  // ---------------- branches: list/get/update/activate via the generic factory, create is custom (adds defaults)
  app.post('/org/branches', async (req, reply) => {
    const a = auth(req);
    const companyId = a.requireCompany();
    a.require('org.branch.manage');
    if (!a.allBranches) throw forbidden('creating branches requires a company-wide role');
    const b = z.object({ code, ...branchFields }).strict().parse(req.body);
    const id = uuidv7();
    const row = await withTx(a.db(), async (tx) => {
      const r = await tx.query(
        `insert into org.branches(id, company_id, code, name, address_line, city, emirate, phone, email, latitude, longitude, timezone,
           vat_registration_no, business_day_cutoff, settings)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,coalesce($14::time,'04:00'),coalesce($15::jsonb,'{}')) returning *`,
        [id, companyId, b.code, b.name, b.addressLine ?? null, b.city ?? null, b.emirate ?? null, b.phone ?? null, b.email ?? null,
         b.latitude ?? null, b.longitude ?? null, b.timezone ?? null, b.vatRegistrationNo ?? null, b.businessDayCutoff ?? null,
         b.settings ? JSON.stringify(b.settings) : null]);
      await createBranchDefaults(tx, companyId, id, b.code);
      return r.rows[0];
    });
    reply.code(201);
    return row;
  });

  registerCrud(app, {
    table: 'org.branches', path: '/org/branches', branchIsId: true,
    viewPermission: 'org.branch.view', managePermission: 'org.branch.manage',
    create: z.object({}), customCreate: true,           // creation handled above (adds warehouses, tax, payment methods)
    update: z.object(branchFields).partial(),
    searchColumns: ['code', 'name', 'city'],
  });
}
