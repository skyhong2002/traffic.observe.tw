import { contributorTraffic, saveContributorPayload } from './contributor.ts';
import { waitForContributor } from './contributor-jobs.ts';
import { type Pool, rows } from './db.ts';
import { publicDomain } from './similarweb.ts';
import { saveTraffic } from './store.ts';

/** Alternate local and configured contributors. Refusals keep the global cooldown. */
export function contributorTransport(pool: Pool, nodes: string[], version: string, ordinary: typeof fetch = fetch) {
  if (nodes.some((node) => !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(node)) || new Set(nodes).size !== nodes.length)
    throw Error('invalid contributor nodes');
  let selected: string | null = null;
  let fetchedAt: string | null = null;
  let sourceVersion = version;
  let sendId: number | null = null;
  const request = (async (input: string, init: RequestInit = {}) => {
    selected = null;
    fetchedAt = null;
    if (!nodes.length) return ordinary(input, init);
    const url = new URL(input);
    const domain = url.searchParams.get('domain');
    if (
      url.origin !== 'https://data.similarweb.com' ||
      url.pathname !== '/api/v1/data' ||
      !domain ||
      publicDomain(domain) !== domain ||
      url.username ||
      url.password ||
      (init.method && init.method !== 'GET') ||
      init.body
    )
      throw Error('invalid contributor request');
    init.signal?.throwIfAborted();
    const [pending] = await rows<{ id: number }>(
      pool,
      "SELECT id FROM sends WHERE domain=? AND outcome='pending' ORDER BY id DESC LIMIT 1",
      [domain],
    );
    if (!pending) throw Error('contributor request requires a reserved send');
    const [previous] = await rows<{ node: string | null }>(
      pool,
      "SELECT JSON_UNQUOTE(JSON_EXTRACT(response_meta,'$.sourceNode')) AS node FROM sends WHERE id < ? ORDER BY id DESC LIMIT 1",
      [pending.id],
    );
    const online = await rows<{ source_node: string }>(pool, 'SELECT source_node FROM contributor_nodes WHERE last_seen_at > ?', [
      new Date(Date.now() - 60_000),
    ]);
    const active = nodes.filter((node) => online.some((entry) => entry.source_node === node));
    const rotation: Array<string | null> = [...active, null];
    selected = rotation[(rotation.indexOf(previous?.node ?? null) + 1) % rotation.length];
    if (!selected) return ordinary(input, init);
    await pool.query("UPDATE sends SET response_meta=JSON_MERGE_PATCH(COALESCE(response_meta,'{}'),?) WHERE id=?", [
      JSON.stringify({
        sourceNode: selected,
        sourceVersion: version,
        egressRoute: `contributor:${selected}`,
        httpClient: 'contributor-docker',
      }),
      pending.id,
    ]);
    sendId = pending.id;
    const result = await waitForContributor(pool, selected, domain, pending.id);
    const reply = result.reply!;
    sourceVersion = result.sourceVersion;
    await pool.query('UPDATE sends SET response_meta=JSON_MERGE_PATCH(response_meta,?) WHERE id=?', [
      JSON.stringify({ sourceVersion }),
      pending.id,
    ]);
    if (
      reply.domain !== domain ||
      reply.requestId !== String(pending.id) ||
      !Number.isInteger(reply.status) ||
      reply.status < 200 ||
      reply.status > 599 ||
      typeof reply.body !== 'string' ||
      Buffer.byteLength(reply.body) > 4 * 1024 * 1024 ||
      !Number.isFinite(Date.parse(reply.fetchedAt)) ||
      Math.abs(Date.parse(reply.fetchedAt) - Date.now()) > 120_000
    )
      throw Error('invalid contributor response');
    fetchedAt = reply.fetchedAt;
    return new Response([204, 205, 304].includes(reply.status) ? null : reply.body, { status: reply.status, headers: reply.headers });
  }) as typeof fetch;
  const save: typeof saveTraffic = async (database, traffic) => {
    if (!selected) return saveTraffic(database, traffic);
    let months = 0;
    let profiles = 0;
    for (const row of traffic) {
      for (const payload of contributorTraffic({ ...row, fetchedAt: fetchedAt ?? row.fetchedAt }, selected, sourceVersion)) {
        await saveContributorPayload(database, payload);
        months++;
        if (payload.fields.some((field) => field !== 'visits')) profiles++;
      }
    }
    if (sendId) await database.query('UPDATE contributor_jobs SET consumed_at=? WHERE send_id=?', [new Date(), sendId]);
    return { months, profiles };
  };
  return { request, save };
}
