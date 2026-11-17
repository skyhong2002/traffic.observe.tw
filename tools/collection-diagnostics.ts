#!/usr/bin/env node
// Local, read-only snapshot. Never sends provider requests or exports credentials.
import { readFile, writeFile } from 'node:fs/promises';
import { collectionMonth, loadCollection } from '../src/collection.ts';
import { createPool } from '../src/db.ts';
import { managedSites } from '../src/metadata.ts';
import { runConfig } from '../src/scheduler.ts';
import { loadThroughput } from '../src/throughput.ts';

const [output, previousFile] = process.argv.slice(2);
if (!output) throw Error('usage: collection-diagnostics.ts snapshot.json [previous-snapshot.json]');
const pool = createPool();
try {
  const config = runConfig(),
    now = new Date(),
    month = collectionMonth(config, now);
  const collection = await loadCollection(pool, config, month, now);
  const throughput = await loadThroughput(
    pool,
    month,
    collection.summary.total - collection.summary.complete,
    collection.summary.missingVisits,
    now,
  );
  const topicRows = (await managedSites(pool)).flatMap((s) => s.topics.map((topic) => ({ domain: s.domain, topic })));
  const tags = [...new Set(topicRows.map((r) => r.topic))].sort().map((tag) => {
    const domains = new Set(topicRows.filter((r) => r.topic === tag).map((r) => r.domain));
    const entries = collection.entries.filter((e) => domains.has(e.domain));
    return {
      tag,
      total: entries.length,
      complete: entries.filter((e) => e.complete).length,
      withVisits: entries.filter((e) => e.fields.visits).length,
    };
  });
  const entries = collection.entries.map((e) => ({ domain: e.domain, complete: e.complete, priority: e.priority, decision: e.decision }));
  let comparison = null;
  if (previousFile) {
    const previous = JSON.parse(await readFile(previousFile, 'utf8')) as {
      at: string;
      month: string;
      entries: typeof entries;
      throughput: typeof throughput;
    };
    const elapsedDays = (now.getTime() - Date.parse(previous.at)) / 86400000;
    const sameCohort =
      previous.month === month &&
      previous.entries
        .map((e) => e.domain)
        .sort()
        .join(',') ===
        entries
          .map((e) => e.domain)
          .sort()
          .join(',');
    const observedNetCompletions = collection.summary.complete - previous.entries.filter((e) => e.complete).length;
    const predictedCompletions = (previous.throughput.complete7d / 7) * elapsedDays;
    comparison = {
      previousAt: previous.at,
      elapsedHours: elapsedDays * 24,
      atLeast24Hours: elapsedDays >= 1,
      sameCohort,
      predictedCompletions: sameCohort ? predictedCompletions : null,
      observedNetCompletions: sameCohort ? observedNetCompletions : null,
      etaProgressErrorDomains: sameCohort ? observedNetCompletions - predictedCompletions : null,
      note: 'ETA calibration compares prior rolling rate against net progress; null when cohort or target changes. Not a claim of production observation.',
    };
  }
  await writeFile(
    output,
    JSON.stringify({ at: now.toISOString(), month, summary: collection.summary, tags, throughput, entries, comparison }, null, 2),
    { mode: 0o600, flag: 'wx' },
  );
} finally {
  await pool.end();
}
