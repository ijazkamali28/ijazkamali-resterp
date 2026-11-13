import { defineConfig } from 'vitest/config';

const TEST_DB = 'restaurant_pos_test';
export default defineConfig({
  test: {
    globalSetup: ['tests/global-setup.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: `postgres://pos_app:pos_app_dev@localhost:5432/${TEST_DB}`,
      DATABASE_OWNER_URL: `postgres://pos_owner:pos_owner_dev@localhost:5432/${TEST_DB}`,
      LOG_LEVEL: 'silent',
      LOGIN_RATE_LIMIT_PER_MINUTE: '1000',
    },
    fileParallelism: false,       // suites share one seeded database
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
