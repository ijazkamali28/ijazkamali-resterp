import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  DATABASE_OWNER_URL: z.string().url().optional(),
  NODE_TYPE: z.enum(['cloud', 'branch_server']).default('cloud'),
  NODE_BRANCH_CODE: z.string().optional().default(''),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('0.0.0.0'),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  SESSION_IDLE_MINUTES: z.coerce.number().positive().default(30),
  LOGIN_MAX_FAILED: z.coerce.number().int().positive().default(5),
  LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  LOGIN_LOCK_MINUTES: z.coerce.number().positive().default(15),
  CORS_ORIGINS: z.string().default(''),
  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof schema>;
export const config: Config = schema.parse(process.env);
