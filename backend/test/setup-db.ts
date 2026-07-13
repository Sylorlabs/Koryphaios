// Test-runner preload: every isolated test process starts with a migrated
// database. Individual tests may call initDb again; migrations are idempotent.
import { initDb } from '../src/db';

await initDb();
