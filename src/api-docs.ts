import { html, layout } from './pages.ts';
import { trafficChannels } from './similarweb.ts';

// The public API, described once: the HTML page at /api/ (laid out like
// tag.observe.tw/api/), the index at /api/v1 and the OpenAPI document at
// /api/v1/openapi.json are all built from ENDPOINTS, so they cannot drift apart.

interface Param {
  name: string;
  in: 'query' | 'path';
  type: string;
  desc: string;
  default?: string;
  required?: boolean;
}
interface Field {
  name: string;
  type: string;
  desc?: string;
}
interface Endpoint {
  id: string;
  method?: 'GET' | 'POST';
  group: string;
  path: string;
  summary: string;
  detail?: string;
  params: Param[];
  /** Path and query of a working example. */
  example: string;
  /** Media type of a successful answer. */
  type: 'application/json' | 'text/csv' | 'image/png';
  fields: Field[];
}

const MONTH: Param = {
  name: 'month',
  in: 'query',
  type: 'string (YYYYMM)',
  desc: '資料月份；未指定或不在範圍內時選最新達 80% 完整欄位覆蓋的月份，沒有月份達標才用最新月份',
  default: '最新達 80% 完整覆蓋的月份',
};
const COVERAGE_FIELD: Field = {
  name: 'coverage',
  type: 'object',
  desc: 'month、scope=tracked、tracked、withVisits、complete、lastUpdatedAt（真實資料時間）；tracked 為追蹤與該月收集名單聯集，complete 不使用估算。CSV 以前置 coverage_* 欄與 X-Coverage-* headers 提供相同值。',
};
const SITE_ROW: Field[] = [
  { name: 'sites[].rank', type: 'integer', desc: '依台灣造訪量（taiwanVisits）的名次，只在篩選後的網站之間計算' },
  { name: 'sites[].domain', type: 'string', desc: '網域' },
  { name: 'sites[].name', type: 'string', desc: '網站名稱（人工值優先，其次試算表）' },
  { name: 'sites[].group', type: 'string | null', desc: '試算表 A 欄（原表標籤 A）' },
  { name: 'sites[].topics', type: 'string[]', desc: '目前的標籤' },
  { name: 'sites[].visits', type: 'number', desc: '當月造訪量，百萬次' },
  { name: 'sites[].prevVisits', type: 'number | null', desc: '比較月份的造訪量，百萬次' },
  { name: 'sites[].growth', type: 'number | null', desc: '與比較月份相比的成長率（0.1＝10%）' },
  { name: 'sites[].prevRank', type: 'integer | null', desc: '比較月份在同一篩選下的名次' },
  {
    name: 'sites[].visitsSource',
    type: '"similarweb" | "manual" | "community" | "sheet"',
    desc: '造訪量來源：Similarweb 免費資料、從 Similarweb 平台手動補登、可信社群節點、GeneHong 試算表',
  },
  { name: 'sites[].searchShare', type: 'number | null', desc: '自然搜尋占造訪的比例（0–1，不含付費搜尋）' },
  { name: 'sites[].aiShare', type: 'number | null', desc: 'GenAI 導流占比（0–1）' },
  { name: 'sites[].taiwanShare', type: 'number | null', desc: '台灣訪客占比（0–1）' },
  {
    name: 'sites[].taiwanVisits',
    type: 'number | null',
    desc: '台灣造訪量 ＝ visits × taiwanShareUsed，百萬次；名次（rank）依此排序，沒有任何占比可用的網站排在最後',
  },
  { name: 'sites[].taiwanShareUsed', type: 'number | null', desc: '排名採用的台灣占比（0–1）：有 taiwanShare 時就是它，否則是估算' },
  {
    name: 'sites[].taiwanBasis',
    type: '"measured" | "manual" | "history" | "bound" | null',
    desc: 'taiwanShareUsed 的依據：measured 是 Similarweb（或試算表）的數字；manual 是編輯者在試算表以 /N 估的 1/N；history 是較早月份的占比；bound 是 Similarweb 前 5 大國家推出的上限',
  },
  {
    name: 'sites[].taiwanShareMax',
    type: 'number | null',
    desc: '台灣占比的上限：台灣不在 Similarweb 前 5 大國家時，不超過第 5 名，也不超過 100% 減前 5 名',
  },
  { name: 'sites[].taiwanCapped', type: 'boolean', desc: 'manual 或 history 的估算高於 taiwanShareMax（含 10% 容許），已改用上限' },
  { name: 'sites[].searchVisits', type: 'number | null', desc: '搜尋S：造訪量 × 自然搜尋占比，百萬次' },
  { name: 'sites[].aiVisits', type: 'number | null', desc: 'AI：造訪量 × GenAI 占比，百萬次' },
  {
    name: 'sites[].taiwanSearchVisits',
    type: 'number | null',
    desc: '台灣搜尋S（估算）：台灣造訪 × 自然搜尋占比，百萬次；假設台灣訪客的導流組成與全站相同',
  },
  { name: 'sites[].taiwanAiVisits', type: 'number | null', desc: '台灣 AI（估算）：台灣造訪 × GenAI 占比，百萬次；同上假設' },
  { name: 'sites[].prevSearchShare', type: 'number | null', desc: '比較月份的自然搜尋占比' },
  { name: 'sites[].prevAiShare', type: 'number | null', desc: '比較月份的 GenAI 占比' },
  { name: 'sites[].prevTaiwanShare', type: 'number | null', desc: '比較月份的台灣訪客占比' },
  {
    name: 'sites[].channels',
    type: 'object | null',
    desc: '當月 Similarweb 各導流來源占比：Direct、SearchOrganic、SearchPaid、SocialOrganic、SocialPaid、Referrals、Mail、DisplayAds、GenAi、Affiliate（0–1）；沒有 Similarweb 估算時為 null',
  },
  { name: 'sites[].prevChannels', type: 'object | null', desc: '比較月份的各導流來源占比' },
];
const RANKING_PARAMS: Param[] = [
  { name: 'q', in: 'query', type: 'string', desc: '搜尋網站名稱或網域；先搜尋再套用筆數上限' },
  MONTH,
  { name: 'topic', in: 'query', type: 'string', desc: '只列出有這個標籤的網站；以逗號分隔多個標籤時，預設需同時有這些標籤（AND）' },
  {
    name: 'topicMode',
    in: 'query',
    type: '"and" | "or"',
    desc: '多標籤比對方式，預設 and；首頁使用 or（符合任一包含的標籤即可），並繼續套用 exclude',
  },
  {
    name: 'exclude',
    in: 'query',
    type: 'string',
    desc: '排除有這些標籤的網站，以逗號分隔（例如 非台灣,內容農場）；API 不套網頁的預設排除',
  },
  { name: 'source', in: 'query', type: '"tag" | "blog" | "manual"', desc: '只列出某個追蹤來源的網域；manual 包含試算表與手動加入' },
  {
    name: 'from',
    in: 'query',
    type: 'string (YYYYMM)',
    desc: '比較月份：成長、前期名次與各占比的前期值都和它比較',
    default: '前一個有資料的月份',
  },
];

export const ENDPOINTS: Endpoint[] = [
  {
    id: 'months',
    group: '排行',
    path: '/api/v1/months',
    summary: '有流量資料的月份',
    params: [],
    example: '/api/v1/months',
    type: 'application/json',
    fields: [{ name: 'months', type: 'string[]', desc: 'YYYYMM，新到舊' }],
  },
  {
    id: 'rankings',
    group: '排行',
    path: '/api/v1/rankings',
    summary: '單一月份的網站排行',
    detail:
      '依台灣造訪量（造訪量 × 台灣占比）由大到小。Similarweb 沒有台灣占比的網站依序用編輯者的 1/N、較早月份的占比、前 5 大國家推出的上限估算（taiwanBasis 註明），都沒有的排在最後。topic、exclude、source 可同時使用；名次在篩選後剩下的網站之間重新計算。沒有 Similarweb 估算的月份用 人工補登或試算表數字，visitsSource 會註明。',
    params: RANKING_PARAMS,
    example: `/api/v1/rankings?month=202609&exclude=${encodeURIComponent('非台灣')}`,
    type: 'application/json',
    fields: [
      { name: 'month', type: 'string (YYYYMM)', desc: '實際使用的月份' },
      { name: 'topic', type: 'string | null' },
      { name: 'exclude', type: 'string[]', desc: '實際排除的標籤（不存在的標籤會被略過）' },
      { name: 'source', type: 'string | null' },
      { name: 'topics', type: 'object[]', desc: '這個月份（套用 source 後、排除前）各標籤的網站數' },
      { name: 'topics[].topic', type: 'string' },
      { name: 'topics[].sites', type: 'integer' },
      { name: 'sites', type: 'object[]', desc: '排行' },
      COVERAGE_FIELD,
      ...SITE_ROW,
    ],
  },
  {
    id: 'rankings-csv',
    group: '排行',
    path: '/api/v1/rankings.csv',
    summary: '同上，以 CSV 下載',
    detail:
      'UTF-8（含 BOM），欄位：名次、網站名、網域、原表標籤 A、標籤、流量(百萬)、成長、上月名次、搜尋S、AI、台灣搜尋S(估算)、台灣AI(估算)、搜尋占比、AI占比、台灣占比、來源。',
    params: RANKING_PARAMS,
    example: `/api/v1/rankings.csv?month=202609&topic=${encodeURIComponent('新聞')}`,
    type: 'text/csv',
    fields: [],
  },
  {
    id: 'history',
    group: '歷史與網站',
    path: '/api/v1/history',
    summary: '網站的歷史造訪量',
    detail:
      '首頁就是讀這一份資料。每個網站、每個月是一個九格陣列，欄位意義見 fields。非管理員依 month、topic、exclude、source、q 選取最多 30 個網站，回傳這些網站的歷史資料。已登入管理員則回傳所有網站；回應不可共用快取。',
    params: RANKING_PARAMS,
    example: '/api/v1/history',
    type: 'application/json',
    fields: [
      { name: 'generatedAt', type: 'string (ISO 時間)', desc: '回應組裝時間；資料最近異動見 coverage[month].lastUpdatedAt' },
      {
        name: 'coverage',
        type: 'object',
        desc: '依月份提供 month、scope=tracked、tracked、withVisits、complete、lastUpdatedAt；分母為 standing watches 與該月收集名單聯集。complete 使用原始欄位，估算不補欄位。',
      },
      { name: 'coverageThreshold', type: 'number', desc: '預設選月門檻 0.8' },
      { name: 'months', type: 'string[]', desc: 'YYYYMM，舊到新' },
      {
        name: 'fields',
        type: 'string[]',
        desc: '每月陣列的欄位：造訪量、搜尋S、AI（百萬次）、台灣占比、來源（0 Similarweb、1 試算表、2 平台補登、3 可信社群）、排名採用的台灣占比、其依據（0 實測、1 編輯者 1/N、2 較早月份、3 上限）、上限、是否因超過上限而改用上限（1 是）',
      },
      { name: 'topics', type: 'string[]', desc: '所有用到的標籤' },
      { name: 'sources', type: 'object[]', desc: '各追蹤來源的網域數（tag、blog、manual）' },
      { name: 'sites', type: 'object', desc: '以網域為鍵' },
      { name: 'sites.<domain>.name', type: 'string' },
      { name: 'sites.<domain>.group', type: 'string | null' },
      { name: 'sites.<domain>.topics', type: 'string[]' },
      { name: 'sites.<domain>.src', type: 'string[]', desc: '定期追蹤這個網域的來源（tag、blog、sheet、manual）' },
      {
        name: 'sites.<domain>.m.<YYYYMM>',
        type: '[number, number | null, number | null, number | null, 0 | 1 | 2, number | null, 0 | 1 | 2 | 3 | null, number | null, 0 | 1]',
      },
      { name: 'radar', type: 'object', desc: '以網域為鍵的 Cloudflare Radar 排名，舊到新' },
      { name: 'radar.<domain>[].date', type: 'string (YYYY-MM-DD)' },
      { name: 'radar.<domain>[].rank', type: 'integer | null', desc: '前 100 名的確切名次' },
      { name: 'radar.<domain>[].bucket', type: 'integer | null', desc: '「前 N 名」級距' },
      { name: 'radar.<domain>[].gt', type: 'integer | null', desc: '「未入前 N 名」' },
      {
        name: 'crux',
        type: 'object',
        desc: '以網域為鍵的 Chrome UX Report 台灣熱門度，舊到新：[YYYYMM, N]，N 是「前 N 名」級距（同一網域取各子網域中最好的名次）',
      },
    ],
  },
  {
    id: 'site',
    group: '歷史與網站',
    path: '/api/v1/sites/{domain}',
    summary: '單一網站的每月數字、試算表紀錄與抓取狀態',
    detail: '每個月分開列出 Similarweb、平台補登與試算表三種數字；網站頁用的就是這一份。沒有任何資料的網域回 404。',
    params: [{ name: 'domain', in: 'path', type: 'string', desc: '網域，例如 udn.com', required: true }],
    example: '/api/v1/sites/udn.com',
    type: 'application/json',
    fields: [
      { name: 'domain', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'topics', type: 'string[]' },
      { name: 'months', type: 'object[]', desc: '舊到新' },
      { name: 'months[].month', type: 'string (YYYYMM)' },
      { name: 'months[].similarweb', type: 'number | null', desc: 'Similarweb 免費資料的造訪量，百萬次' },
      { name: 'months[].noEstimate', type: 'boolean', desc: 'Similarweb 回傳 0，表示這個月沒有估算' },
      { name: 'months[].manual', type: 'number | null', desc: '從 Similarweb 平台手動補登的造訪量，百萬次' },
      { name: 'months[].sheet', type: 'number | null', desc: '試算表的造訪量，百萬次' },
      { name: 'months[].searchShare', type: 'number | null' },
      { name: 'months[].aiShare', type: 'number | null' },
      { name: 'months[].taiwanShare', type: 'number | null' },
      {
        name: 'labels',
        type: 'object[]',
        desc: '試算表原始紀錄：month、name、group（A 欄）、topics（B 欄）、visits、adjusted（人工調整，不採用）',
      },
      {
        name: 'profile',
        type: 'object | null',
        desc: '最新月份組成（免費估算優先，否則平台補登，source=manual）：month、countries（前 5 名 code、share）、channels（Direct、SearchOrganic、SearchPaid、SocialOrganic、SocialPaid、Referrals、Mail、DisplayAds、GenAi、Affiliate 的占比）、bounceRate、pagesPerVisit、timeOnSite（秒）、globalRank、countryRank、categoryRank',
      },
      {
        name: 'manualProfiles',
        type: 'object[]',
        desc: '僅管理員：所有手動補登月份的完整 profile，免費估算存在時仍保留。breakdowns 含 Social、Referral 來源網站/產業、連出目的地/廣告主、Display 刊登網站及各渠道總占比。明細 share 為 {value: 0–1, bound: lt | gt | null}，name=null 表示未公開名稱，change 保留平台字串（如 >5000%、New）；各表分母不同。',
      },
      {
        name: 'manualProfiles[].desktopChannels',
        type: 'object | undefined',
        desc: '僅管理員：Worldwide／Desktop Only 渠道占比（0–1），鍵名同 channels；獨立於全裝置 channels，不能乘以全裝置月造訪量換算次數。未補登的渠道保持未知。',
      },
      { name: 'category', type: 'string | null', desc: 'Similarweb 的網站類別，例如 Finance/Investing' },
      { name: 'similarSites', type: 'string[]', desc: 'Similarweb 列出的相似網站' },
      { name: 'tags', type: 'object[]', desc: '每個標籤的來源與票數，同 /api/v1/tags/{domain}' },
      { name: 'watchers', type: 'object[]', desc: '追蹤這個網域的來源：requester、kind、requestedAt' },
      { name: 'radar', type: 'object[]', desc: 'Cloudflare Radar：dateStart、dateEnd、rank、bucket、bucketLowerBound、fetchedAt' },
      {
        name: 'crux',
        type: 'object[]',
        desc: 'Chrome UX Report 台灣熱門度，舊到新：month、rank（前 N 名級距）、host（取得這個名次的網址）',
      },
      {
        name: 'state',
        type: 'object | null',
        desc: 'Similarweb 抓取狀態：lastSuccessAt、lastAttemptAt、nextAttemptAt、failures、lastError',
      },
    ],
  },
  {
    id: 'site-tags',
    group: '標籤',
    path: '/api/v1/tags/{domain}',
    summary: '單一網站的每個標籤、來源與投票數',
    detail:
      '包含未顯示的標籤。編輯清單（或試算表）的標籤一律顯示；AI 初判在不同意比同意多 2 票時隱藏；讀者新增的標籤在同意多於不同意時顯示；管理員覆寫優先。只回票數，不回投票者。未知網域回 404。',
    params: [{ name: 'domain', in: 'path', type: 'string', desc: '網域，例如 udn.com', required: true }],
    example: '/api/v1/tags/udn.com',
    type: 'application/json',
    fields: [
      { name: 'domain', type: 'string' },
      { name: 'tags', type: 'object[]', desc: '顯示中的在前' },
      { name: 'tags[].tag', type: 'string' },
      {
        name: 'tags[].source',
        type: '"editor" | "sheet" | "ai" | "community" | "admin"',
        desc: '編輯清單、試算表、AI 初判、讀者新增、管理員覆寫',
      },
      { name: 'tags[].visible', type: 'boolean', desc: '是否顯示在網站與排行上' },
      { name: 'tags[].agrees', type: 'integer' },
      { name: 'tags[].disagrees', type: 'integer' },
      { name: 'tags[].adminOverride', type: '"set" | "hide" | null' },
    ],
  },
  {
    id: 'tech',
    group: '網站技術',
    path: '/api/v1/tech',
    summary: '各網站首頁偵測到的技術與統計',
    detail:
      '範圍是所有追蹤清單與試算表的網域。每個首頁約一個月檢查一次，比對 Wappalyzer 社群版規則中本站列出的技術；「unknown」表示首頁沒有清單內技術的痕跡，不代表沒有技術。technologies 依 source 篩選後計算，sites 再依 category、technology、status 篩選。',
    params: [
      { name: 'source', in: 'query', type: '"tag" | "blog" | "manual"', desc: '只看某個追蹤來源的網域' },
      { name: 'category', in: 'query', type: 'string', desc: '只列出有這類技術的網站，例如 cms、cdn、analytics、ads' },
      { name: 'technology', in: 'query', type: 'string', desc: '只列出用這項技術的網站，例如 wordpress' },
      {
        name: 'status',
        in: 'query',
        type: '"detected" | "unknown" | "failed" | "blocked" | "unchecked"',
        desc: '只列出最近一次是這個結果的網站',
      },
    ],
    example: '/api/v1/tech?technology=wordpress',
    type: 'application/json',
    fields: [
      { name: 'rules', type: 'string | null', desc: '目前的規則版本（wappalyzer-<commit 前 12 碼>）' },
      { name: 'coverage', type: 'object', desc: 'sites、checked、withSnapshot（有成功結果）、detected、unknown、failed、blocked' },
      { name: 'technologies[]', type: 'object', desc: 'id、name、category、sites（用它的網站數），多到少' },
      { name: 'sites[].domain', type: 'string' },
      { name: 'sites[].status', type: '"detected" | "unknown" | "failed" | "blocked" | null', desc: '最近一次檢查的結果；null 是還沒檢查' },
      {
        name: 'sites[].errorCode',
        type: 'string | null',
        desc: 'robots、waf、rate-limit、http-error、not-html、timeout、network、dns、address',
      },
      { name: 'sites[].observedAt', type: 'string | null', desc: '保留的成功結果是何時讀到的；之後失敗也會保留' },
      { name: 'sites[].origin', type: '"traffic" | "blog" | null', desc: 'blog 是從 blog.observe.tw 併入、本站還沒自己檢查過的結果' },
      { name: 'sites[].detections[]', type: 'object', desc: 'id、name、category、version（只來自 meta generator，否則 unknown）' },
    ],
  },
  {
    id: 'tech-domain',
    group: '網站技術',
    path: '/api/v1/tech/{domain}',
    summary: '單一網域的技術偵測結果、依據與檢查紀錄',
    detail: '任何檢查過的網域都有，包括有人在 /tech/ 查詢、不在追蹤清單裡的網域。沒檢查過回 404。',
    params: [{ name: 'domain', in: 'path', type: 'string', desc: '網域，例如 udn.com', required: true }],
    example: '/api/v1/tech/udn.com',
    type: 'application/json',
    fields: [
      { name: 'status', type: '"detected" | "unknown" | "failed" | "blocked"', desc: '最近一次檢查的結果' },
      { name: 'errorCode', type: 'string | null' },
      { name: 'httpStatus', type: 'integer | null' },
      { name: 'lastAttemptAt', type: 'string' },
      { name: 'observedAt', type: 'string | null' },
      { name: 'sourceUrl', type: 'string | null', desc: '讀到的頁面（轉址後，去掉查詢字串）' },
      { name: 'ruleVersion', type: 'string | null' },
      { name: 'origin', type: '"traffic" | "blog"' },
      {
        name: 'detections[]',
        type: 'object',
        desc: 'id、name、category、confidence（0–1，CDN 與主機最多 0.4）、version、ruleId、ruleVersion、observedAt、evidence（kind 與固定的規則類別說明，不含頁面內容）',
      },
    ],
  },
  {
    id: 'topics-all',
    group: '標籤',
    path: '/api/v1/topics/all',
    summary: '跨月份的標籤彙整',
    detail:
      '以網站目前的標籤彙整所有已知月份；同一網域在一個標籤內只算一次。指定 topic 時另附該標籤的網站清單（非管理員最多 30 筆）；不存在的標籤回 404。',
    params: [{ name: 'topic', in: 'query', type: 'string', desc: '加上這個標籤的網站清單' }],
    example: `/api/v1/topics/all?topic=${encodeURIComponent('新聞')}`,
    type: 'application/json',
    fields: [
      { name: 'scope', type: '"all"' },
      { name: 'months', type: 'string[]', desc: '有流量資料的月份' },
      { name: 'topics', type: 'object[]', desc: '依累計造訪量排序' },
      { name: 'topics[].topic', type: 'string' },
      { name: 'topics[].sites', type: 'integer', desc: '網站數（含尚無流量的網站）' },
      { name: 'topics[].sitesWithData', type: 'integer' },
      { name: 'topics[].visits', type: 'number | null', desc: '累計造訪量，百萬次' },
      { name: 'topics[].searchShare', type: 'number | null', desc: '以有資料的網站月份加權' },
      { name: 'topics[].aiShare', type: 'number | null' },
      { name: 'topic', type: 'string', desc: '指定 topic 時才有' },
      {
        name: 'sites',
        type: 'object[]',
        desc: '指定 topic 時才有：domain、name、topics、months（有資料月數）、visits、searchShare、aiShare',
      },
    ],
  },
  {
    id: 'topics-month',
    group: '標籤',
    path: '/api/v1/topics',
    summary: '單一月份的標籤統計與成長',
    detail: '舊版介面，保留給既有使用者；新的使用方式請用 /api/v1/topics/all。',
    params: [MONTH],
    example: '/api/v1/topics?month=202609',
    type: 'application/json',
    fields: [
      { name: 'month', type: 'string (YYYYMM)' },
      { name: 'topics[].topic', type: 'string' },
      { name: 'topics[].sites', type: 'integer' },
      { name: 'topics[].visits', type: 'number', desc: '當月造訪量合計，百萬次' },
      { name: 'topics[].visitsGrowth', type: 'number | null' },
      { name: 'topics[].searchShare', type: 'number | null' },
      { name: 'topics[].aiShare', type: 'number | null' },
      { name: 'topics[].searchGrowth', type: 'number | null' },
      { name: 'topics[].aiGrowth', type: 'number | null' },
    ],
  },
  {
    id: 'icon',
    group: '歷史與網站',
    path: '/icon/{domain}',
    summary: '網站圖示（64×64 PNG）',
    detail: '只回應本站已知的網域；圖示由伺服器向 Google favicon 服務抓取並快取 30 天。沒有圖示時回 404。',
    params: [{ name: 'domain', in: 'path', type: 'string', desc: '網域', required: true }],
    example: '/icon/udn.com',
    type: 'image/png',
    fields: [],
  },
  {
    id: 'status',
    group: '抓取與服務',
    path: '/api/v1/status',
    summary: '各類資料更新來源與 Similarweb 排程',
    detail:
      '區分 Similarweb 請求、網站首頁技術掃描、Radar API 與本站資料查詢。零請求的排程檢查只讀本機資料庫。通用目標月份依必抓、核心、台灣、其他安排缺漏，完成後移出該月份佇列。所有入口共用滾動一小時上限、請求間隔、每日探查與拒絕冷卻；這些本機上限不代表已確認的伺服器額度。',
    params: [],
    example: '/api/v1/status',
    type: 'application/json',
    fields: [
      { name: 'budget', type: 'integer', desc: 'Similarweb 每輪上限' },
      {
        name: 'cruxUntracked',
        type: 'object',
        desc: 'Chrome UX Report 最新一期台灣前 5,000 名中，不屬於任何追蹤網域的網址：month、top、total、hosts（host、rank，最多 300 個）',
      },
      {
        name: 'activities',
        type: 'object',
        desc: 'similarweb、websiteTechnology、cloudflareRadar、chromeUxReport、storedDataApi；各自的 label、destination、usesSimilarwebQuota，以及適用的頻率、最後時間與近 24 小時計數。首頁掃描以網域站次計算，並非 HTTP 請求總數；storedDataApi 指狀態／流量／技術 GET 查詢，只讀已儲存資料。',
      },
      {
        name: 'policy',
        type: 'object',
        desc: '本機抓取政策（不是已確認的伺服器額度）。reason：disabled、weekly-limit、hourly-limit、request-spacing、recovery-probe-limit、provider-cooldown、waiting-for-month 或 null；resumeAt：最早可恢復時間（不保證伺服器已解除限制）；maxPerRun：當前可送數；initialPending：相容舊模式的首次抓取網域數（月份收集模式為 0）；nextProbeAt：最早可再次探查的時間；hourly：limit、used、remaining（滾動一小時，含所有預留）；minIntervalSeconds：一般請求間隔；recovery：phase、source、providerRetryAt、nextAttemptAt、refusals、successes、requiredSuccesses、intervalMinutes、limit、used、remaining、budgetResumesAt、spacingUntil（null 表示不在恢復階段；恢復探查另受滾動 24 小時上限）；weekly：limit、used、remaining、startsAt、resetsAt（UTC 週一重置，所有預留及送出的請求均計入；auto 模式的 limit、remaining 為 null，代表未設本機固定週上限，仍遵守探查間隔及拒絕退避，不代表伺服器無限額）；waitingForMonth、targetMonth、latestMonth、latestProfileMonth、probeIntervalHours、coolingDownUntil',
      },
      { name: 'priority', type: 'string[]', desc: '相容舊模式的來源優先序' },
      {
        name: 'egressExperiment',
        type: 'object | null',
        desc: '有界出口比較：id、limit（最多 3 次）、remaining、nextRoute（direct／vessel-tokyo／vessel-singapore）、trials（sendId、at、domain、egressRoute、outcome、httpStatus、latestMonth、latestProfileMonth 及可取得的限額／Retry-After 證據）。只使用原定恢復探查，共用冷卻與限速，不因拒絕立即換出口；單站樣本不能推論各 IP 額度。',
      },
      {
        name: 'collection',
        type: 'object | null',
        desc: '月份收集摘要：month、total、complete、withVisits、partial、missingVisits、manualNeeded、waitingRetry、eligible、priorities（各級 total、complete）',
      },
      { name: 'coolingDownUntil', type: 'string (ISO 時間) | null', desc: '被 Similarweb 拒絕後暫停到何時' },
      {
        name: 'refusedSince',
        type: 'string (ISO 時間) | null',
        desc: '最近三輪都被 Similarweb 拒絕、一筆都沒抓到時，從何時開始；這段期間 queue 的 expectedAt 是 null',
      },
      {
        name: 'lastMonth',
        type: 'object',
        desc: 'month：上個月（YYYYMM）；sampled、found：近一天（本月內）有流量回應的網域數，與其中已有這個月資料的數量；catchUpPerRun：缺這個月的網域每輪可補抓幾個（每輪上限乘以 found／sampled，至少 1）',
      },
      { name: 'watched', type: 'integer', desc: '追蹤中的網域數' },
      { name: 'due', type: 'integer', desc: '目前到期的網域數' },
      {
        name: 'queue',
        type: 'object[]',
        desc: '排程：domain、position、requester、reason（collection、new、refresh、catch-up、lookup）、targetMonth、importance、missing、lastSuccessAt、expectedAt；暫停、限額、等待探查、或超出目前可用額度時 expectedAt 為 null',
      },
      { name: 'watchers', type: 'object[]', desc: '各來源與類型的網域數：requester、kind、domains' },
      { name: 'last24h', type: 'object', desc: '近 24 小時的請求結果計數' },
      {
        name: 'requests',
        type: 'object[]',
        desc: '最近 24 筆已保存請求的安全診斷：sendId、at、domain、outcome、httpStatus、egressRoute、httpClient、experiment、diagnosticsRecorded、provider、cache、pop、contentType、retryAfter、retrySource、quotaExceeded、latestMonth、latestProfileMonth。沒有 response body、request ID、Cookie 或憑證。舊紀錄缺少的欄位會是 null。',
      },
      {
        name: 'runs',
        type: 'object[]',
        desc: 'Similarweb 紀錄：activity（provider-request／schedule-check）、destination、usesSimilarwebQuota、startedAt、finishedAt、budget、sent、ok、failed、refused、note；sent=0 為只讀本站的排程檢查，不是上游請求',
      },
    ],
  },
  {
    id: 'contributors-upload',
    method: 'POST',
    group: '社群資料',
    path: '/api/v1/contributors/upload',
    summary: '提交社群節點觀察紀錄',
    detail:
      '需要維護者簽發的 15 分鐘 Bearer token。單筆或最多 100 筆陣列，整個 request 最多 1 MiB，每個 payload 最多 256 KiB；節點每分鐘 30 次。造訪量為整數次（不是百萬）。不接受 Cookie、裝置 ID、headers 或任何額外欄位。只接受已追蹤網域。2xx 來源必須有正整數 visits；失敗來源必須是空 payload。批次部分成功回 207，每筆有 ok/error；全成功 201。重送冪等。',
    params: [],
    example: '/api/v1/contributors/upload',
    type: 'application/json',
    fields: [
      { name: 'accepted', type: 'integer' },
      { name: 'rejected', type: 'integer' },
      { name: 'results', type: 'object[]', desc: 'ok、idempotencyKey、duplicate、canonicalId、reason 或安全錯誤碼。回應順序與輸入一致。' },
    ],
  },
  {
    id: 'contributors',
    group: '來源與狀態',
    path: '/api/v1/contributors/{domain}',
    summary: '查詢社群節點觀測與 canonical 選擇',
    detail:
      '只讀已保存的 contributor provenance；所有來源列都保留，canonical 依來源信任、欄位完整度與抓取時間決定。上傳需短期 token，不會由此端點觸發上游請求。',
    params: [
      { name: 'domain', in: 'path', type: 'string', desc: '網域，例如 example.com', required: true },
      { name: 'month', in: 'query', type: 'string (YYYYMM)', desc: '只看指定月份' },
    ],
    example: '/api/v1/contributors/example.com?month=202610',
    type: 'application/json',
    fields: [
      { name: 'domain', type: 'string' },
      {
        name: 'canonical',
        type: 'object',
        desc: '以月份為鍵的持久 canonical；來源信任被移除時為 null。enabled 決定是否納入前台，decisions 顯示寫入時理由與時間。',
      },
      { name: 'observations', type: 'object[]', desc: '所有來源列與 payload hash' },
    ],
  },
  {
    id: 'collection',
    group: '抓取與服務',
    path: '/api/v1/collection',
    summary: '通用月份逐站缺漏清單',
    detail: '純讀取，沒有額外上游請求。合併該月自動資料與人工補登判定完整性；缺值不補零，歷史缺漏保留。優先級由編輯於月份收集頁管理。',
    params: [
      {
        name: 'month',
        in: 'query',
        type: 'string (YYYYMM)',
        desc: '精確查詢月份，不自動改為其他月份',
        default: '設定的目標月份（預設上一個月）',
      },
    ],
    example: '/api/v1/collection?month=202610',
    type: 'application/json',
    fields: [
      { name: 'month', type: 'string', desc: '目標 YYYYMM' },
      {
        name: 'summary',
        type: 'object',
        desc: 'total、complete、withVisits、partial、missingVisits、manualNeeded、waitingRetry、eligible，以及各優先級完成數',
      },
      { name: 'settings', type: 'object', desc: 'coreDomains、maxAttempts、retryHours' },
      {
        name: 'entries',
        type: 'object[]',
        desc: 'domain、name、month、priority（1 必抓／2 核心／3 台灣／4 其他）、priorityOverride（0 自動）、priorityLabel、status（complete／pending／retry／retry-wait／manual-needed）、complete、missing、availableFields、attempts（總嘗試）、budgetAttempts（不含只收到舊月份的嘗試）、lastAttemptAt、lastResult、nextAttemptAt、automatic、hasAutomatic、hasManual、sources、cruxRank、rareTags（至多 20 個收集網站才有的標籤；同優先級內，有稀有標籤的網站以 10 倍台灣流量排序）；nextAttemptAt 不含全域冷卻，實際政策請讀 status',
      },
    ],
  },
  {
    id: 'index',
    group: '抓取與服務',
    path: '/api/v1',
    summary: '端點索引（JSON）',
    params: [],
    example: '/api/v1/',
    type: 'application/json',
    fields: [
      { name: 'service', type: 'string' },
      { name: 'docs', type: 'string', desc: '這份文件的網址' },
      { name: 'openapi', type: 'string', desc: 'OpenAPI 規格的網址' },
      { name: 'endpoints', type: 'object', desc: '「方法 路徑」對應用途' },
    ],
  },
  {
    id: 'openapi',
    group: '抓取與服務',
    path: '/api/v1/openapi.json',
    summary: 'OpenAPI 3.1 規格',
    params: [],
    example: '/api/v1/openapi.json',
    type: 'application/json',
    fields: [],
  },
];

/** The JSON index at /api/v1, kept with the keys it has always had. */
export const apiIndex = (origin: string) => ({
  service: 'site.observe.tw',
  source: 'Similarweb extension estimates (monthly visits per domain, in millions) plus a hand-kept sheet for months Similarweb lacks',
  docs: `${origin}/api/`,
  openapi: `${origin}/api/v1/openapi.json`,
  endpoints: Object.fromEntries(
    ENDPOINTS.map((e) => [
      `${e.method ?? 'GET'} ${e.path}${
        e.params.some((p) => p.in === 'query')
          ? `?${e.params
              .filter((p) => p.in === 'query')
              .map((p) => `${p.name}=`)
              .join('&')}`
          : ''
      }`,
      e.summary,
    ]),
  ),
});

const schemaType = (type: string) =>
  /integer/.test(type)
    ? 'integer'
    : /number/.test(type)
      ? 'number'
      : /boolean/.test(type)
        ? 'boolean'
        : /\[\]/.test(type)
          ? 'array'
          : /object/.test(type)
            ? 'object'
            : 'string';

/** OpenAPI 3.1: parameters as typed, responses with their top-level fields described. */
export const openApi = (origin: string) => ({
  openapi: '3.1.0',
  info: {
    title: '網站雷達 API',
    version: '1',
    description: '台灣網站每月的 Similarweb 造訪估算、搜尋與 AI 導流、Cloudflare Radar 排名與標籤彙整。造訪量單位為百萬次，占比為 0–1。',
  },
  servers: [{ url: origin }],
  components: {
    securitySchemes: { contributorToken: { type: 'http', scheme: 'bearer', description: 'Node-bound HMAC token, valid for 15 minutes' } },
    schemas: {
      ContributorObservation: {
        type: 'object',
        additionalProperties: false,
        required: [
          'domain',
          'targetMonth',
          'fetchedAt',
          'sourceNode',
          'sourceVersion',
          'schemaVersion',
          'responseStatus',
          'fields',
          'payloadHash',
          'payload',
        ],
        properties: {
          domain: { type: 'string' },
          targetMonth: { type: 'string', pattern: '^20[0-9]{2}(0[1-9]|1[0-2])$' },
          fetchedAt: { type: 'string', format: 'date-time' },
          sourceNode: { type: 'string', maxLength: 64 },
          sourceVersion: { type: 'string', maxLength: 64 },
          schemaVersion: { const: 1 },
          responseStatus: { type: 'integer', minimum: 100, maximum: 599 },
          fields: { type: 'array', items: { type: 'string' } },
          payloadHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          payload: {
            type: 'object',
            additionalProperties: false,
            properties: {
              visits: { type: 'integer', minimum: 0 },
              channels: {
                type: 'object',
                additionalProperties: false,
                properties: Object.fromEntries(trafficChannels.map((key) => [key, { type: 'number', minimum: 0, maximum: 1 }])),
                description: 'Known channel shares; total <= 1.001',
              },
              countries: {
                type: 'array',
                maxItems: 250,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['code', 'share'],
                  properties: { code: { type: 'string', pattern: '^[A-Z]{2}$' }, share: { type: 'number', minimum: 0, maximum: 1 } },
                },
              },
              bounceRate: { type: 'number', minimum: 0, maximum: 1 },
              pagesPerVisit: { type: 'number', minimum: 0 },
              timeOnSite: { type: 'number', minimum: 0 },
            },
          },
        },
      },
    },
  },
  paths: Object.fromEntries(
    ENDPOINTS.map((e) => [
      e.path,
      {
        [(e.method ?? 'GET').toLowerCase()]: {
          ...(e.method === 'POST'
            ? {
                security: [{ contributorToken: [] }],
                requestBody: {
                  required: true,
                  content: {
                    'application/json': {
                      schema: {
                        oneOf: [
                          { $ref: '#/components/schemas/ContributorObservation' },
                          { type: 'array', minItems: 1, maxItems: 100, items: { $ref: '#/components/schemas/ContributorObservation' } },
                        ],
                      },
                    },
                  },
                },
              }
            : {}),
          operationId: e.id,
          tags: [e.group],
          summary: e.summary,
          ...(e.detail ? { description: e.detail } : {}),
          parameters: e.params.map((p) => ({
            name: p.name,
            in: p.in,
            required: p.in === 'path' || !!p.required,
            description: p.desc,
            schema: { type: 'string', ...(p.default && p.default !== '最新月份' ? { default: p.default } : {}) },
          })),
          responses: {
            [e.method === 'POST' ? 201 : 200]: {
              description: e.summary,
              content: {
                [e.type]: {
                  schema:
                    e.type === 'application/json'
                      ? {
                          type: 'object',
                          properties: Object.fromEntries(
                            e.fields
                              .filter((f) => !/[.[]/.test(f.name))
                              .map((f) => [f.name, { type: schemaType(f.type), description: [f.type, f.desc].filter(Boolean).join('：') }]),
                          ),
                        }
                      : { type: 'string', ...(e.type === 'image/png' ? { format: 'binary' } : {}) },
                },
              },
            },
            ...(e.method === 'POST'
              ? {
                  207: { description: 'Batch partially accepted; inspect each results[].ok' },
                  400: { description: 'Invalid observation or batch' },
                  401: { description: 'Missing, expired or invalid node token' },
                  429: { description: 'Node rate limit; honor Retry-After' },
                }
              : {}),
            ...(e.params.some((p) => p.in === 'path') || e.id === 'topics-all' ? { 404: { description: '{"error": "..."}' } } : {}),
          },
        },
      },
    ]),
  ),
});

const anchor = (e: Endpoint) => `api-${e.id}`;
const code = (s: string) => `<code>${html(s)}</code>`;

export function apiDocsPage(origin: string) {
  const groups = [...new Set(ENDPOINTS.map((e) => e.group))];
  const endpoint = (e: Endpoint) => {
    const url = `${origin}${e.example}`;
    const params = e.params.length
      ? `<table class="doc-table"><thead><tr><th>參數</th><th>型別</th><th>說明</th></tr></thead><tbody>${e.params
          .map(
            (p) =>
              `<tr><td>${code(p.name)}${p.in === 'path' ? '<small>路徑</small>' : ''}</td><td>${html(p.type)}</td><td>${html(p.desc)}${p.default ? `，預設 ${code(p.default)}` : ''}</td></tr>`,
          )
          .join('')}</tbody></table>`
      : '';
    const fields = e.fields.length
      ? `<details class="doc-fields"><summary>回應欄位<span>${e.fields.length} 個</span></summary><table class="doc-table"><tbody>${e.fields
          .map((f) => `<tr><td>${code(f.name)}</td><td>${html(f.type)}</td><td>${html(f.desc ?? '')}</td></tr>`)
          .join('')}</tbody></table></details>`
      : '';
    return `<section class="doc-endpoint" id="${anchor(e)}"><h3><span class="method">${e.method ?? 'GET'}</span><span class="path">${html(e.path)}</span></h3>
<p class="doc-summary">${html(e.summary)}</p>${e.detail ? `<p class="note">${html(e.detail)}</p>` : ''}${params}
${e.method === 'POST' ? '<p class="note">節點範例、標準化輸入與重試操作見專案 README。請以 Authorization: Bearer 傳送節點 token。</p>' : `<div class="doc-example"><pre><code>curl -s '${html(url)}'</code></pre><a href="${html(e.example)}" rel="noopener">在瀏覽器開啟這個範例 ↗</a></div>`}${fields}</section>`;
  };
  const quick = `# 2026 年 9 月的排行，排除「非台灣」，取前 10 名
curl -s '${origin}/api/v1/rankings?month=202609&exclude=%E9%9D%9E%E5%8F%B0%E7%81%A3' | jq '.sites[:10][] | {rank, name, visits}'

# 單一網站每個月的造訪量（百萬次）
curl -s '${origin}/api/v1/sites/udn.com' | jq -r '.months[] | [.month, .similarweb // .manual // .sheet] | @tsv'`;
  const js = `const res = await fetch('${origin}/api/v1/rankings?month=202609&topic=' + encodeURIComponent('新聞'));
const { sites } = await res.json();
for (const s of sites.slice(0, 10)) console.log(s.rank, s.name, s.visits.toFixed(2) + 'm');`;
  const py = `import requests

r = requests.get("${origin}/api/v1/topics/all", params={"topic": "新聞"})
for s in r.json()["sites"][:10]:
    print(s["name"], s["visits"])`;
  const rules = [
    '未登入或已登入的非管理員，流量數值只提供兩位有效數字、國家只提供台灣，導流來源只提供自然搜尋、直接、連入、社群與 AI。',
    '非管理員的網站清單在任何篩選條件下最多回傳 30 筆，不提供載入更多；CSV 也適用。只有登入的管理員可查看完整資料與全部筆數。',
    `基底網址 ${code(origin)}，查詢使用 ${code('GET')}，回傳 UTF-8 JSON（CSV 與圖示除外），不需要 API 金鑰。社群上傳使用 POST，必須提供節點 Bearer token。`,
    `允許跨網域（CORS ${code('Access-Control-Allow-Origin: *')}），瀏覽器前端可直接呼叫。`,
    `造訪量單位是<b>百萬次</b>（${code('757.3')} ＝ 757.3m）；占比與成長率是 0–1 的小數（${code('0.36')} ＝ 36%）；月份寫成 ${code('YYYYMM')}；時間一律是 UTC 的 ISO 8601。`,
    `數字是 Similarweb 的造訪估算，不是 page views。Similarweb 沒有估算的月份改用從 Similarweb 平台補登的數字或 GeneHong 試算表，以 ${code('visitsSource')} 標明；Similarweb 回傳 0 視為沒有估算。`,
    `狀態／流量／技術 GET API 只讀已儲存資料，不會觸發 Similarweb 或首頁掃描；自動查詢建議每小時一次。網站技術每天一批，Cloudflare Radar 每天一次，Chrome UX Report 每天檢查一次新月份；Similarweb 依限速與冷卻決定是否送出。`,
    `錯誤回 ${code('{"error": "..."}')} 加上 HTTP 狀態碼，例如 ${code('404')} 找不到網域或標籤。`,
    `路徑與參數中的網域、標籤請 URL 編碼。網頁上的排行預設排除「非台灣」，API 不會，需要時請自行傳 ${code('exclude')}。`,
    `${code('v1')} 只做向後相容的變更（新增欄位、新增端點）；移除或改名會先在這份文件公告。`,
    `使用資料請註明「資料來源：網站雷達 site.observe.tw（Similarweb 估算）」。`,
  ];
  const toc = `<nav class="doc-toc" aria-label="本頁大綱"><p>本頁大綱</p><a href="#rules">使用規則</a><a href="#quick">快速開始</a><a href="#list">端點一覽</a>${groups
    .map(
      (g) =>
        `<a href="#group-${html(g)}">${html(g)}</a>${ENDPOINTS.filter((e) => e.group === g)
          .map((e) => `<a class="sub" href="#${anchor(e)}">${e.method ?? 'GET'} ${html(e.path)}</a>`)
          .join('')}`,
    )
    .join('')}</nav>`;
  return layout(
    'API',
    {
      title: '網站雷達 API',
      dek: '公開取用台灣網站每月的造訪估算、搜尋與 AI 導流、Radar 排名與標籤彙整',
    },
    `<div class="doc-links"><a href="/api/v1/openapi.json">OpenAPI 3.1 規格</a><a href="/api/v1/">端點索引 JSON</a></div>
<div class="doc-layout"><div class="doc-main">
<section class="block" id="rules"><h2>使用規則</h2><ul class="doc-rules">${rules.map((r) => `<li>${r}</li>`).join('')}</ul></section>
<section class="block" id="quick"><h2>快速開始</h2><p class="note">命令列（curl + jq）</p><pre><code>${html(quick)}</code></pre><p class="note">JavaScript（瀏覽器或 Node 18+）</p><pre><code>${html(js)}</code></pre><p class="note">Python</p><pre><code>${html(py)}</code></pre></section>
<section class="block" id="list"><h2>端點一覽</h2><table class="doc-table"><thead><tr><th>端點</th><th>用途</th></tr></thead><tbody>${ENDPOINTS.map(
      (e) => `<tr><td><a href="#${anchor(e)}">${code(`${e.method ?? 'GET'} ${e.path}`)}</a></td><td>${html(e.summary)}</td></tr>`,
    ).join('')}</tbody></table></section>
${groups
  .map(
    (g) =>
      `<section class="block" id="group-${html(g)}"><h2>${html(g)}</h2>${ENDPOINTS.filter((e) => e.group === g)
        .map(endpoint)
        .join('')}</section>`,
  )
  .join('')}
</div>${toc}</div>`,
  );
}
