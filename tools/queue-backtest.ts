#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { backtestQueue, type QueueSite, type ReplayObservation } from '../src/queue-plan.ts';

const [input, output, budget = '50', at = '2026-11-17T00:00:00Z'] = process.argv.slice(2);
if (!input || !output) throw Error('usage: queue-backtest.ts snapshot.json report.json [budget] [ISO time]');
const data = JSON.parse(await readFile(input, 'utf8')) as { entries: QueueSite[]; observations?: ReplayObservation[] } | QueueSite[];
const entries = Array.isArray(data) ? data : data.entries;
if (!Number.isSafeInteger(Number(budget)) || Number(budget) < 0 || !Number.isFinite(Date.parse(at))) throw Error('invalid budget or time');
await writeFile(
  output,
  JSON.stringify(
    {
      at,
      budget: Number(budget),
      reports: backtestQueue(entries, Number(budget), new Date(at), Array.isArray(data) ? undefined : data.observations),
    },
    null,
    2,
  ),
);
