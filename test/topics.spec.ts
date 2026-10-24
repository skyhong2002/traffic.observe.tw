import { describe, expect, it } from 'vitest';
import type { History } from '../src/history.ts';
import { topicsPage } from '../src/pages.ts';
import { aggregateTopics } from '../src/topics.ts';

const traffic = (m: History['sites'][string]['m']): History['sites'][string] => ({
  name: '舊名稱',
  group: null,
  topics: ['舊標籤'],
  src: [],
  m,
});

describe('all-month topics', () => {
  it('counts current membership once and weights each channel over only its known observations', () => {
    const data = aggregateTopics(
      {
        sites: {
          'a.tw': traffic({ '202608': [10, 5, 0.1, null, 0], '202609': [30, null, 0.9, null, 1] }),
          'b.tw': traffic({ '202608': [20, 4, null, null, 0] }),
          'removed.tw': traffic({ '202609': [100, 80, 10, null, 0] }),
        },
      },
      [
        { domain: 'a.tw', name: '新名稱', topics: ['科技', '個人', '科技'] },
        { domain: 'b.tw', name: 'B', topics: ['科技'] },
        { domain: 'waiting.tw', name: '還沒有流量', topics: ['科技', '新標籤'] },
        { domain: 'removed.tw', name: '已移除標籤', topics: [] },
      ],
    );
    expect(data.months).toEqual(['202608', '202609']);
    // The overview draws a tag cloud; a tag's page lists the tags its sites also carry.
    expect(topicsPage(data)).toContain('class="cloud"');
    expect(topicsPage(data, '科技')).toMatch(/常一起出現的標籤[\s\S]*topic=%E5%80%8B%E4%BA%BA[\s\S]*新標籤/);
    expect(data.topics.find((t) => t.topic === '科技')).toMatchObject({
      sites: 3,
      sitesWithData: 2,
      visits: 60,
      searchShare: 0.3,
      aiShare: 0.025,
    });
    expect(data.topics.find((t) => t.topic === '個人')).toMatchObject({ sites: 1, visits: 40, searchShare: 0.5 });
    expect(data.topics.find((t) => t.topic === '新標籤')).toMatchObject({
      sites: 1,
      sitesWithData: 0,
      visits: null,
      searchShare: null,
      aiShare: null,
    });
    expect(data.topics.map((t) => t.topic)).not.toContain('舊標籤');
    expect(data.sites.find((s) => s.domain === 'a.tw')).toMatchObject({ name: '新名稱', topics: ['科技', '個人'], months: 2, visits: 40 });
    expect(data.sites.filter((s) => s.topics.includes('科技'))).toHaveLength(3);
  });

  it('distinguishes zero from missing traffic and renders tags even before any months exist', () => {
    const data = aggregateTopics(
      {
        sites: {
          'zero.tw': traffic({ '202609': [10, 0, 0, null, 0] }),
          'empty.tw': traffic({ '202609': [0, 0, 0, null, 0] }),
        },
      },
      [
        { domain: 'zero.tw', name: 'Zero', topics: ['零占比'] },
        { domain: 'empty.tw', name: 'Empty', topics: ['零流量'] },
      ],
    );
    expect(data.topics.find((t) => t.topic === '零占比')).toMatchObject({ visits: 10, searchShare: 0, aiShare: 0 });
    expect(data.topics.find((t) => t.topic === '零流量')).toMatchObject({ sitesWithData: 1, visits: 0, searchShare: null, aiShare: null });
    const pending = aggregateTopics({ sites: {} }, [{ domain: 'pending.tw', name: 'Pending', topics: ['新標籤'] }]);
    expect(pending.months).toEqual([]);
    expect(topicsPage(pending)).toContain('尚無流量資料');
    expect(topicsPage(pending, '新標籤')).toContain('/site/pending.tw/');
    // Both lists sort by their headers and can be searched in the browser (tables.js).
    for (const page of [topicsPage(pending), topicsPage(pending, '新標籤')]) {
      expect(page).toContain('<table data-sortable');
      expect(page).toMatch(/data-table-filter="(topics|members)"/);
    }
  });
});
