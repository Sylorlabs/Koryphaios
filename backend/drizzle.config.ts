import type { Config } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL;

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: databaseUrl?.startsWith('postgres') ? 'postgresql' : 'sqlite',
  dbCredentials: {
    url: databaseUrl || '.koryphaios/koryphaios.db',
  },
} satisfies Config;
