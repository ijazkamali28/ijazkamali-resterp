import { writeFileSync } from 'node:fs';
import { migrate } from '../src/db/migrate.js';

export default async function setup() {
  const url = 'postgres://pos_owner:pos_owner_dev@localhost:5432/restaurant_pos_test';
  process.env.DATABASE_URL ??= 'postgres://pos_app:pos_app_dev@localhost:5432/restaurant_pos_test';
  await migrate(url, { reset: true, log: () => undefined });
  const { seed } = await import('../db/seeds/seed.js');
  const result = await seed(url, { log: () => undefined });
  writeFileSync(new URL('./.seed.json', import.meta.url), JSON.stringify(result));
}
