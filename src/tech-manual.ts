import { type Pool, rows } from './db.ts';
import { EditError } from './metadata.ts';
import { html, layout, tw } from './pages.ts';
import { publicDomain } from './similarweb.ts';
import { PRODUCTS, type TechCategory } from './tech.ts';

export interface ManualTech {
  id: string;
  name: string;
  category: TechCategory;
  observedAt: string;
  sourceUrl: string;
  source: 'manual';
  version: 'unknown';
}
export async function loadManualTech(pool: Pool, domains?: string[]) {
  if (domains && !domains.length) return new Map<string, ManualTech[]>();
  const records = await rows<{ domain: string; products: string | string[]; source_url: string; observed_at: Date }>(
    pool,
    `SELECT domain, products, source_url, observed_at FROM tech_manual${domains ? ' WHERE domain IN (?)' : ''}`,
    domains ? [domains] : [],
  );
  return new Map(
    records.map((r) => [
      r.domain,
      (typeof r.products === 'string' ? (JSON.parse(r.products) as string[]) : r.products).flatMap((id) => {
        const product = PRODUCTS.get(id);
        return product
          ? [
              {
                ...product,
                source: 'manual' as const,
                sourceUrl: r.source_url,
                observedAt: r.observed_at.toISOString(),
                version: 'unknown' as const,
              },
            ]
          : [];
      }),
    ]),
  );
}
export async function saveManualTech(pool: Pool, domain: string, by: string, body: Record<string, unknown>, now = new Date()) {
  const remove = body.action === 'delete';
  const ids = String(body.products ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);
  const products = [...new Set(ids)];
  let source = '';
  let observed = now;
  if (!remove) {
    if (!products.length || products.length > 100 || products.some((id) => !PRODUCTS.has(id)))
      throw new EditError('請選擇清單中的技術代碼，最多 100 項。');
    try {
      const url = new URL(String(body.sourceUrl ?? ''));
      if (
        url.href.length > 2048 ||
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.port ||
        !publicDomain(url.hostname)
      )
        throw Error();
      source = url.href;
    } catch {
      throw new EditError('請提供公開 HTTPS 佐證網址，不可包含帳密、查詢參數或片段。');
    }
    observed = new Date(String(body.observedAt ?? ''));
    if (!Number.isFinite(observed.getTime()) || observed > now || observed < new Date('2000-01-01'))
      throw new EditError('請填寫有效且非未來的觀察日期。');
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      'INSERT INTO tech_manual_log (domain, editor, action, products, source_url, observed_at, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [domain, by, remove ? 'delete' : 'save', JSON.stringify(products), source || null, remove ? null : observed, now],
    );
    if (remove) await conn.query('DELETE FROM tech_manual WHERE domain = ?', [domain]);
    else
      await conn.query(
        'INSERT INTO tech_manual (domain, products, source_url, observed_at, updated_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE products = VALUES(products), source_url = VALUES(source_url), observed_at = VALUES(observed_at), updated_at = VALUES(updated_at)',
        [domain, JSON.stringify(products), source, observed, now],
      );
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}
export function manualTechPage(domain: string, records: ManualTech[], error = '') {
  const first = records[0];
  return layout(
    `${domain} 技術補登`,
    {
      title: '人工確認網站技術',
      dek: `為 ${html(domain)} 記錄有公開佐證的技術，與首頁自動掃描分開保存。`,
      actions: `<a href="/tech/${html(domain)}/">返回技術資料</a>`,
    },
    `${error ? `<p role="alert">${html(error)}</p>` : ''}<form method="post" class="manual-form"><label>技術代碼（每行一個）<textarea name="products" rows="6" required>${records.map((r) => html(r.id)).join('\n')}</textarea></label><label>公開佐證網址<input name="sourceUrl" type="url" required value="${html(first?.sourceUrl ?? '')}" placeholder="https://example.com/about/"></label><label>觀察日期<input type="date" name="observedAt" required value="${html(first?.observedAt.slice(0, 10) ?? new Date().toISOString().slice(0, 10))}"></label><p>只補登已確認的技術。未知版本保持未知；自動掃描結果與阻擋狀態會繼續保留。</p><button type="submit">儲存人工確認</button> <button name="action" value="delete" formnovalidate>刪除人工確認</button></form><details><summary>可用技術代碼</summary><dl>${[...PRODUCTS].map(([id, p]) => `<dt><code>${html(id)}</code></dt><dd>${html(p.name)}</dd>`).join('')}</dl></details>${first ? `<p>最近確認：${tw(first.observedAt)}</p>` : ''}`,
    { nav: 'tech' },
  );
}
