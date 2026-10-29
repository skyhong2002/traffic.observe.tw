import { html, layout } from './pages.ts';

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
  desc: '資料月份；不在資料範圍內時改用最新月份',
  default: '最新月份',
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
    type: '"similarweb" | "manual" | "sheet"',
    desc: '造訪量來源：Similarweb 免費資料、從 Similarweb 平台手動補登、GeneHong 試算表',
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
  { name: 'topic', in: 'query', type: 'string', desc: '只列出有這個標籤的網站；以逗號分隔多個標籤時，需同時有這些標籤（AND）' },
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
      ...SITE_ROW,
    ],
  },
  {
    id: 'rankings-csv',
    group: '排行',
    path: '/api/v1/rankings.csv',
    summary: '同上，以 CSV 下載',
    detail:
      'UTF-8（含 BOM），欄位：名次、網站名、網域、原表標籤 A、標籤、流量(百萬)、成長、上月名次、搜尋S、AI、搜尋占比、AI占比、台灣占比、來源。',
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
      { name: 'generatedAt', type: 'string (ISO 時間)' },
      { name: 'months', type: 'string[]', desc: 'YYYYMM，舊到新' },
      {
        name: 'fields',
        type: 'string[]',
        desc: '每月陣列的欄位：造訪量、搜尋S、AI（百萬次）、台灣占比、來源（0 Similarweb、1 試算表、2 平台補登）、排名採用的台灣占比、其依據（0 實測、1 編輯者 1/N、2 較早月份、3 上限）、上限、是否因超過上限而改用上限（1 是）',
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
      { name: 'category', type: 'string | null', desc: 'Similarweb 的網站類別，例如 Finance/Investing' },
      { name: 'similarSites', type: 'string[]', desc: 'Similarweb 列出的相似網站' },
      { name: 'tags', type: 'object[]', desc: '每個標籤的來源與票數，同 /api/v1/tags/{domain}' },
      { name: 'watchers', type: 'object[]', desc: '追蹤這個網域的來源：requester、kind、requestedAt' },
      { name: 'radar', type: 'object[]', desc: 'Cloudflare Radar：dateStart、dateEnd、rank、bucket、bucketLowerBound、fetchedAt' },
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
        desc: 'robots、waf、rate-limit、http-error、not-html、timeout、network、address',
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
    summary: 'Similarweb 抓取排程與最近批次',
    detail: '抓取狀態頁用的資料。每小時一輪，每輪最多 budget 個網域。',
    params: [],
    example: '/api/v1/status',
    type: 'application/json',
    fields: [
      { name: 'budget', type: 'integer', desc: '每輪上限' },
      { name: 'priority', type: 'string[]', desc: '來源的優先序' },
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
        desc: '排程：domain、position、requester、reason（new、refresh、catch-up、lookup）、lastSuccessAt、expectedAt',
      },
      { name: 'watchers', type: 'object[]', desc: '各來源與類型的網域數：requester、kind、domains' },
      { name: 'last24h', type: 'object', desc: '近 24 小時的請求結果計數' },
      { name: 'runs', type: 'object[]', desc: '最近批次：startedAt、finishedAt、budget、sent、ok、failed、refused、note' },
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
      `GET ${e.path}${
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
  paths: Object.fromEntries(
    ENDPOINTS.map((e) => [
      e.path,
      {
        get: {
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
            200: {
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
    return `<section class="doc-endpoint" id="${anchor(e)}"><h3><span class="method">GET</span><span class="path">${html(e.path)}</span></h3>
<p class="doc-summary">${html(e.summary)}</p>${e.detail ? `<p class="note">${html(e.detail)}</p>` : ''}${params}
<div class="doc-example"><pre><code>curl -s '${html(url)}'</code></pre><a href="${html(e.example)}" rel="noopener">在瀏覽器開啟這個範例 ↗</a></div>${fields}</section>`;
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
    `基底網址 ${code(origin)}，全部是 ${code('GET')}，回傳 UTF-8 JSON（CSV 與圖示除外）。不需要 API 金鑰。`,
    `允許跨網域（CORS ${code('Access-Control-Allow-Origin: *')}），瀏覽器前端可直接呼叫。`,
    `造訪量單位是<b>百萬次</b>（${code('757.3')} ＝ 757.3m）；占比與成長率是 0–1 的小數（${code('0.36')} ＝ 36%）；月份寫成 ${code('YYYYMM')}；時間一律是 UTC 的 ISO 8601。`,
    `數字是 Similarweb 的造訪估算，不是 page views。Similarweb 沒有估算的月份改用從 Similarweb 平台補登的數字或 GeneHong 試算表，以 ${code('visitsSource')} 標明；Similarweb 回傳 0 視為沒有估算。`,
    `Similarweb 每小時更新一批網域、Cloudflare Radar 每天一次；請勿以高於每 10 分鐘的頻率輪詢。`,
    `錯誤回 ${code('{"error": "..."}')} 加上 HTTP 狀態碼，例如 ${code('404')} 找不到網域或標籤。`,
    `路徑與參數中的網域、標籤請 URL 編碼。網頁上的排行預設排除「非台灣」，API 不會，需要時請自行傳 ${code('exclude')}。`,
    `${code('v1')} 只做向後相容的變更（新增欄位、新增端點）；移除或改名會先在這份文件公告。`,
    `使用資料請註明「資料來源：網站雷達 site.observe.tw（Similarweb 估算）」。`,
  ];
  const toc = `<nav class="doc-toc" aria-label="本頁大綱"><p>本頁大綱</p><a href="#rules">使用規則</a><a href="#quick">快速開始</a><a href="#list">端點一覽</a>${groups
    .map(
      (g) =>
        `<a href="#group-${html(g)}">${html(g)}</a>${ENDPOINTS.filter((e) => e.group === g)
          .map((e) => `<a class="sub" href="#${anchor(e)}">GET ${html(e.path)}</a>`)
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
      (e) => `<tr><td><a href="#${anchor(e)}">${code(`GET ${e.path}`)}</a></td><td>${html(e.summary)}</td></tr>`,
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
