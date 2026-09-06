/**
 * A WAL never shrinks on its own: only `wal_checkpoint(TRUNCATE)` reclaims the file, and a
 * long-running server never closes its DB (observed locally: a 154 MB WAL on a 143 MB base).
 *
 * The scheduler cannot be exercised directly in a unit test: it gates itself off under
 * `isAutomatedTestProcess()`, same as the pre-existing DB health-check scheduler it is
 * modeled on (see tests/unit/lib/jobRegistry/boot-wiring.test.ts for the same constraint).
 * This reads the wiring instead.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const CORE_PATH = "src/lib/db/core.ts";
const MAINTENANCE_PATH = "src/lib/db/walMaintenance.ts";

test("a periodic WAL truncate scheduler is started when the DB instance boots", () => {
  const source = readSource(CORE_PATH);
  assert.match(
    source,
    /startWalMaintenance\(db/,
    "getDbInstance() must start the WAL maintenance scheduler alongside the DB health-check scheduler"
  );
});

test("the WAL truncate scheduler runs wal_checkpoint(TRUNCATE), not a lighter mode", () => {
  const source = readSource(MAINTENANCE_PATH);
  assert.match(
    source,
    /wal_checkpoint\(TRUNCATE\)/,
    "the scheduled checkpoint must request TRUNCATE mode — a lighter mode would not shrink the WAL file"
  );
});

test("the WAL truncate scheduler is cleared on close, like the health-check scheduler", () => {
  const source = readSource(CORE_PATH);
  const fnStart = source.indexOf("export function closeDbInstance");
  assert.notEqual(fnStart, -1, "closeDbInstance must exist");
  const fnBody = source.slice(fnStart, fnStart + 300);
  assert.match(fnBody, /clearDbHealthCheckScheduler\(\)/);
  assert.match(
    fnBody,
    /stopWalMaintenance\(\)/,
    "closeDbInstance() must stop the WAL maintenance timer so it does not outlive the DB handle"
  );
});

test("the truncate interval is overridable via OMNIROUTE_WAL_TRUNCATE_INTERVAL_MS", () => {
  const source = readSource(MAINTENANCE_PATH);
  assert.match(
    source,
    /OMNIROUTE_WAL_TRUNCATE_INTERVAL_MS/,
    "the interval must be operator-configurable, matching OMNIROUTE_DB_HEALTHCHECK_INTERVAL_MS"
  );
});

test("the scheduler self-gates the same way the DB health-check scheduler does", () => {
  const source = readSource(MAINTENANCE_PATH);
  assert.match(source, /isCloud/);
  assert.match(source, /isNextBuildPhase\(\)/);
  assert.match(source, /isAutomatedTestProcess\(\)/);
});

test("the new env var is documented", () => {
  const docs = readSource("docs/reference/ENVIRONMENT.md");
  assert.match(
    docs,
    /OMNIROUTE_WAL_TRUNCATE_INTERVAL_MS/,
    "docs/reference/ENVIRONMENT.md must document the new env var (check:env-doc-sync)"
  );
});

test("close carries the busy streak into the checkpoint log", () => {
  const source = readSource(CORE_PATH);
  const fnStart = source.indexOf("export function closeDbInstance");
  assert.notEqual(fnStart, -1, "closeDbInstance must exist");
  const fnBody = source.slice(fnStart, fnStart + 1200);
  assert.match(fnBody, /getWalMaintenanceState\(\)\.busyStreak/);
  assert.match(fnBody, /runCheckpointNow\(db, checkpointMode, \{/);
  assert.match(fnBody, /logCheckpointOutcome\(outcome, checkpointMode, streakBefore\)/);
});
