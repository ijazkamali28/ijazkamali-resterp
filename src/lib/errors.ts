export class AppError extends Error {
  constructor(public statusCode: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export const badRequest = (msg: string, details?: unknown) => new AppError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'authentication required') => new AppError(401, 'unauthorized', msg);
export const forbidden = (msg = 'permission denied', details?: unknown) => new AppError(403, 'forbidden', msg, details);
export const notFound = (msg = 'not found') => new AppError(404, 'not_found', msg);
export const conflict = (msg: string, details?: unknown) => new AppError(409, 'conflict', msg, details);

/** Translate PostgreSQL errors into API errors without leaking internals. */
export function fromPgError(err: any): AppError | null {
  if (!err || typeof err.code !== 'string') return null;
  switch (err.code) {
    case '23505': return new AppError(409, 'duplicate', 'a record with the same unique value already exists', { constraint: err.constraint });
    case '23503': return new AppError(422, 'invalid_reference', 'referenced record does not exist or is not accessible', { constraint: err.constraint });
    case '23514': return new AppError(422, 'constraint_violation', 'value violates a business rule', { constraint: err.constraint });
    case '23502': return new AppError(422, 'missing_value', `missing required value: ${err.column}`);
    case '22P02': return new AppError(400, 'invalid_format', 'invalid value format');
    case '42501': return new AppError(403, 'forbidden', 'access to this record is not permitted');
    case 'P0001': return new AppError(409, 'business_rule', err.message);
    case 'P0002': return new AppError(409, 'insufficient_stock', err.message);
    case 'P0003': return new AppError(422, 'unbalanced_journal', err.message);
    default: return null;
  }
}
