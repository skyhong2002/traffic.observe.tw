// Similarweb's English platform and extension screenshots. Coordinates keep
// chart axes, country changes and device-limited sections out of copied values.
const countries = {
  Taiwan: 'TW',
  'United States': 'US',
  Canada: 'CA',
  Thailand: 'TH',
  Japan: 'JP',
  'Hong Kong': 'HK',
  China: 'CN',
  Singapore: 'SG',
  Malaysia: 'MY',
  Australia: 'AU',
  'United Kingdom': 'GB',
  'South Korea': 'KR',
  Germany: 'DE',
  France: 'FR',
  India: 'IN',
  Vietnam: 'VN',
  Indonesia: 'ID',
  Philippines: 'PH',
  Netherlands: 'NL',
  'New Zealand': 'NZ',
};
export const screenshotCountryCodes = { ...countries, 台灣: 'TW' };
export const screenshotFields = {
  visits: '月造訪量',
  taiwan: '台灣占比',
  search: '自然搜尋',
  ai: 'Gen AI',
  Direct: '直接造訪',
  Referrals: '其他網站連入',
  SocialOrganic: '自然社群',
  SocialPaid: '社群廣告',
  SearchPaid: '搜尋廣告',
  Mail: '電子郵件',
  DisplayAds: '展示廣告',
  Affiliate: '聯盟行銷',
  bounce: '跳出率',
  pages: '每次造訪頁數',
  duration: '平均停留時間',
  countries: '國家占比',
};
const channels = [
  ['Direct', /\bDirect\b/i],
  ['search', /\b(?:Org\.?|Organic)\s*Search\b/i, /\bSearch\s*Organic\b/i],
  ['SearchPaid', /\bPaid\s*Search\b/i, /\bSearch\s*Paid\b/i],
  ['Referrals', /\bReferrals?\b/i],
  ['DisplayAds', /\bDisplay(?:\s*Ads)?\b/i],
  ['SocialOrganic', /\b(?:Org\.?|Organic)\s*Social\b/i, /\bSocial\s*Organic\b/i],
  ['SocialPaid', /\bPaid\s*Social\b/i, /\bSocial\s*Paid\b/i],
  ['ai', /\bGen\s*A[Il1]\b/i],
  ['Mail', /\bEmail\b/i],
  ['Affiliate', /\bAffiliates?\b/i],
];
const desktopKey = (key) => 'desktop_' + ({ search: 'SearchOrganic', ai: 'GenAi' }[key] || key);
for (const [key] of channels) screenshotFields[desktopKey(key)] = '桌面限定・' + screenshotFields[key];

function rowsOf(tsv) {
  const words = tsv
    .split('\n')
    .slice(1)
    .map((line) => {
      const c = line.split('\t');
      return { level: c[0], x: +c[6], y: +c[7], w: +c[8], h: +c[9], confidence: +c[10], text: c.slice(11).join('\t').trim() };
    })
    .filter((w) => w.level === '5' && w.text && [w.x, w.y, w.w, w.h, w.confidence].every(Number.isFinite));
  const rows = [];
  for (const word of words.sort((a, b) => a.y + a.h / 2 - b.y - b.h / 2)) {
    const center = word.y + word.h / 2;
    let row = rows.find((r) => Math.abs(r.center - center) <= Math.max(4, Math.min(r.height, word.h) * 0.6));
    if (!row) {
      row = { center, height: word.h, words: [] };
      rows.push(row);
    }
    row.words.push(word);
  }
  return rows.map((row) => {
    let text = '';
    for (const word of row.words.sort((a, b) => a.x - b.x)) {
      word.start = text.length;
      text += word.text + ' ';
      word.end = text.length;
    }
    return { ...row, text: text.trim() };
  });
}
function phrase(row, pattern) {
  const match = pattern.exec(row.text);
  if (!match) return null;
  const words = row.words.filter((w) => w.end > match.index && w.start < match.index + match[0].length);
  const x = Math.min(...words.map((w) => w.x)),
    right = Math.max(...words.map((w) => w.x + w.w));
  return { x, right, center: (x + right) / 2, y: row.center };
}
const percent = (word) => /^\d+(?:\.\d+)?%$/.test(word.text) && Number(word.text.slice(0, -1)) <= 100;
const bounded = (row, word) => row.words.some((w) => /^[<>≤≥]$/.test(w.text) && w.x < word.x && word.x - w.x - w.w < word.h);

/** Re-read uncertain percentages from enlarged image crops, never infer a missing decimal. */
export async function refineScreenshotNumbers(tsv, recognize) {
  const lines = tsv.split('\n');
  let attempts = 0;
  for (let i = 1; i < lines.length && attempts < 20; i++) {
    const c = lines[i].split('\t');
    const value = c.slice(11).join('\t').trim();
    if (c[0] !== '5' || !/^\d+(?:\.\d+)?%$/.test(value) || (+c[10] >= 80 && Number(value.slice(0, -1)) <= 100)) continue;
    const region = { x: +c[6], y: +c[7], w: +c[8], h: +c[9] };
    if (!Object.values(region).every(Number.isFinite) || region.w <= 0 || region.h <= 0) continue;
    attempts++;
    const retry = await recognize(region);
    const words = retry
      .split('\n')
      .map((line) => line.split('\t'))
      .filter((word) => word[0] === '5' && word[11]?.trim());
    if (words.length !== 1) continue;
    const candidate = words[0][11].trim();
    if (+words[0][10] >= 80 && percent({ text: candidate }) && candidate.replace('.', '') === value.replace('.', '')) {
      c[10] = words[0][10];
      c[11] = candidate;
      lines[i] = c.join('\t');
    }
  }
  return lines.join('\n');
}

/** Re-read incomplete country tables with another segmentation mode. Never infer a country from a remainder. */
export async function reviewScreenshotCountries(tsv, primary, recognize) {
  const rows = rowsOf(tsv);
  const heading = rows.find((r) => /\bCountry\b.*Traffic\s*share|\bTop\s*5\s*Countries\b|^Country$/i.test(r.text));
  if (!heading) return primary;
  const sources = rows.find((r) => /\bTraffic\s*Sources\b/i.test(r.text));
  if (rows.some((r) => /\b(?:Desktop|Mobile)\b/i.test(r.text) && (!sources || r.center <= sources.center))) return primary;
  const end = rows.find((r) => r.center > heading.center && /\bSee\s*more\s*countries\b|\bTraffic\s*Sources\b/i.test(r.text));
  const table = rows.filter((r) => r.center > heading.center && (!end || r.center < end.center));
  const expected = table.filter((r) => r.words.some((w) => /^\d+(?:\.\d+)?%$/.test(w.text))).length;
  const sharesOf = (result) => {
    const shares = (result.fields.countries || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' '));
    // An independently recognized Taiwan scalar stays usable even when another
    // bad country made that pass reject its whole list (e.g. 0.57% read as 57%).
    if (result.fields.taiwan !== undefined && !shares.some(([code]) => code === 'TW')) shares.push(['TW', result.fields.taiwan]);
    return shares;
  };
  const initial = sharesOf(primary);
  if (initial.length >= 5 && initial.length >= expected) return primary;
  const secondary = await recognize();
  const shares = new Map(),
    conflicts = new Set();
  for (const [code, value] of [...initial, ...sharesOf(secondary)]) {
    if (conflicts.has(code)) continue;
    if (shares.has(code) && Number(shares.get(code)) !== Number(value)) {
      shares.delete(code);
      conflicts.add(code);
    } else shares.set(code, value);
  }
  const fields = { ...primary.fields };
  const warnings = primary.warnings.filter(
    (warning) => !Object.entries(countries).some(([name, code]) => shares.has(code) && warning.startsWith(`國家占比（${name}）`)),
  );
  for (const code of conflicts) warnings.push(`國家占比（${code}）兩次辨識數值不一致，請手動核對。`);
  if ([...shares.values()].reduce((sum, value) => sum + Number(value), 0) > 100.1) {
    shares.clear();
    warnings.push('兩次辨識的國家占比合計超過 100%，請手動核對。');
  }
  delete fields.countries;
  delete fields.taiwan;
  if (shares.size)
    fields.countries = [...shares]
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .map(([code, value]) => `${code} ${value}`)
      .join('\n');
  if (shares.has('TW')) fields.taiwan = shares.get('TW');
  if (shares.size < expected) warnings.push('國家表仍有漏辨識，請核對台灣占比與國家列表，缺少的資料可手動補上。');
  const result = { ...primary, fields, warnings: [...new Set(warnings)] };
  if (primary.sources) {
    result.sources = { ...primary.sources };
    const uncertain = {};
    for (const pass of [primary, secondary])
      for (const [key, regions] of Object.entries(pass.uncertainSources || {})) {
        if (fields[key] === undefined) (uncertain[key] ||= []).push(...regions);
      }
    if (Object.keys(uncertain).length) result.uncertainSources = uncertain;
    for (const key of ['countries', 'taiwan']) {
      result.sources[key] = [
        ...(primary.sources[key] || []),
        ...(secondary.sources?.[key] || []),
        ...(key === 'countries'
          ? [...(primary.sources.taiwan || []), ...(secondary.sources?.taiwan || [])].map((s) => ({ ...s, value: 'TW ' + s.value }))
          : []),
      ].filter((source) =>
        key === 'countries' ? (fields.countries || '').split('\n').includes(source.value) : fields.taiwan === source.value,
      );
    }
  }
  return result;
}

export function parseScreenshot(tsv, includeSources = false) {
  let rows = rowsOf(tsv);
  const sourceRegions = {},
    uncertainRegions = {};
  const record = (key, value, words, uncertain = false) => {
    if (!includeSources) return;
    const x = Math.min(...words.map((w) => w.x)),
      y = Math.min(...words.map((w) => w.y));
    const right = Math.max(...words.map((w) => w.x + w.w)),
      bottom = Math.max(...words.map((w) => w.y + w.h));
    const target = uncertain ? uncertainRegions : sourceRegions;
    (target[key] ||= []).push({ value, x, y, w: right - x, h: bottom - y });
  };
  const fields = {},
    conflicts = new Set(),
    warnings = [],
    months = new Set();
  const text = rows.map((r) => r.text).join('\n');
  const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  for (const match of text
    .replace(/0ct/gi, 'Oct')
    .matchAll(
      /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s*(20\d{2})\b/gi,
    ))
    months.add(match[2] + String(monthNames.indexOf(match[1].slice(0, 3).toLowerCase()) + 1).padStart(2, '0'));
  const deviceRows = rows.filter((r) => /\b(?:Desktop|Mobile)\s*(?:Web|traffic|only)?\b/i.test(r.text));
  const sources = rows.find((r) => /\bTraffic\s*Sources\b/i.test(r.text));
  const sourceRows = sources ? rows.filter((r) => r.center > sources.center) : [];
  const sourceScope = sourceRows.map((r) => r.text).join('\n');
  const desktopSources = /\bWorldwide\b/i.test(sourceScope) && /\bDesktop\s*Only\b/i.test(sourceScope) && !/\bMobile\b/i.test(sourceScope);
  if (deviceRows.length) {
    if (!sources || deviceRows.some((r) => r.center <= sources.center)) {
      return { fields, months: [...months], warnings: ['這張截圖顯示 Desktop 或 Mobile 範圍，請改用 Worldwide／All traffic 截圖。'] };
    }
    warnings.push(
      desktopSources
        ? 'Desktop Only 流量來源將填入獨立的「桌面限定」欄位，不會覆寫全裝置渠道或換算全裝置造訪次數。'
        : '流量來源未能確認為 Worldwide／Desktop Only 或 All traffic，已略過該區塊；上方國家資料仍可核對填入。',
    );
  }
  // A source card has its own device filter; it must never set the scope of
  // engagement metrics or the independent (possibly title-cropped) country card.
  if (sources) rows = rows.filter((r) => r.center < sources.center);
  const usableText = rows.map((r) => r.text).join('\n');
  if (!/\bWorldwide\b/i.test(usableText) || !/\bAll\s*traffic\b/i.test(usableText))
    warnings.push('截圖未完整辨識出 Worldwide／All traffic，請核對範圍。');
  const put = (key, word, row, regionWords) => {
    if (conflicts.has(key)) return;
    if (word.confidence < 80 || bounded(row, word)) {
      record(key, word.text, regionWords || row.words.filter((w) => w.x <= word.x + word.w), true);
      warnings.push(`${screenshotFields[key]}不夠清楚或含有界限，請手動核對。`);
      return;
    }
    const value = word.text.replace(/%$/, '');
    if (fields[key] !== undefined && fields[key] !== value) {
      delete fields[key];
      conflicts.add(key);
      warnings.push(`${screenshotFields[key]}出現多個不同數值，請手動輸入。`);
    } else {
      fields[key] = value;
      record(key, value, regionWords || row.words.filter((w) => w.x <= word.x + word.w));
    }
  };
  for (const [key, pattern, valuePattern] of [
    ['visits', /\b(?:Monthly|Total)\s*visits\b/i, /^\d+(?:\.\d+)?[KMB]$/i],
    ['pages', /\bPages\s*(?:\/|per)\s*visit\b/i, /^\d+(?:\.\d+)?$/],
    ['duration', /\bVisit\s*duration\b/i, /^\d+:[0-5]\d(?::[0-5]\d)?$/],
    ['bounce', /\bBounce\s*rate\b/i, /^\d+(?:\.\d+)?%$/],
  ]) {
    for (const row of rows) {
      const label = phrase(row, pattern);
      if (!label) continue;
      const candidate = row.words.find((w) => w.x > label.right && valuePattern.test(w.text));
      if (candidate) put(key, candidate, row);
    }
  }
  const countryShares = [];
  const geography = rows.find((r) => /\bCountry\b.*Traffic\s*share|\bTop\s*5\s*Countries\b|^Country$/i.test(r.text));
  const geographyEnd = rows.find((r) => geography && r.center > geography.center && /\bSee\s*more\s*countries\b/i.test(r.text));
  for (const row of geography ? rows.filter((r) => r.center > geography.center && (!geographyEnd || r.center < geographyEnd.center)) : []) {
    for (const [name, code] of Object.entries(countries)) {
      const label = phrase(row, new RegExp(`\\b${name}\\b`, 'i'));
      if (!label) continue;
      const value = row.words.find((w) => w.x > label.right && percent(w));
      if (!value) {
        warnings.push(`國家占比（${name}）未能確定數值，請手動核對。`);
        continue;
      }
      if (value.confidence < 80 || bounded(row, value)) {
        record(
          'countries',
          code + ' ' + value.text,
          row.words.filter((w) => w.x <= value.x + value.w),
          true,
        );
        if (code === 'TW')
          record(
            'taiwan',
            value.text,
            row.words.filter((w) => w.x <= value.x + value.w),
            true,
          );
        warnings.push(`國家占比（${name}）不夠清楚或含有界限，請手動核對。`);
        continue;
      }
      countryShares.push({ code, value: value.text.slice(0, -1) });
      record(
        'countries',
        code + ' ' + value.text.slice(0, -1),
        row.words.filter((w) => w.x <= value.x + value.w),
      );
      if (code === 'TW') put('taiwan', value, row);
    }
  }
  if (
    countryShares.length &&
    new Set(countryShares.map((c) => c.code)).size === countryShares.length &&
    countryShares.reduce((sum, c) => sum + Number(c.value), 0) <= 100.1
  )
    fields.countries = countryShares.map((c) => `${c.code} ${c.value}`).join('\n');
  const heading = rows.find((r) => /Channels\s*overview/i.test(r.text));
  if (heading)
    for (const row of rows.filter((r) => r.center > heading.center)) {
      const labels = channels
        .map(([key, pattern]) => ({ key, ...phrase(row, pattern) }))
        .filter((p) => p.center !== undefined)
        .sort((a, b) => a.center - b.center);
      if (labels.length < 4) continue;
      labels.forEach((label, i) => {
        const gap = Math.min(
          i ? label.center - labels[i - 1].center : Infinity,
          i < labels.length - 1 ? labels[i + 1].center - label.center : Infinity,
        );
        const candidates = rows
          .filter((r) => r.center > heading.center && r.center < row.center - row.height)
          .flatMap((r) => r.words.filter((w) => percent(w) && Math.abs(w.x + w.w / 2 - label.center) < gap * 0.4).map((w) => ({ w, r })));
        if (candidates.length === 1) put(label.key, candidates[0].w, candidates[0].r, [candidates[0].w]);
        else warnings.push(`${screenshotFields[label.key]}未能確定圖表數值，請手動核對。`);
      });
      break;
    }
  if (sources) {
    if (desktopSources || (/\bWorldwide\b/i.test(sourceScope) && /\bAll\s*traffic\b/i.test(sourceScope) && !deviceRows.length))
      for (const row of sourceRows)
        for (const [key, pattern, extensionPattern = pattern] of channels) {
          const label = phrase(row, extensionPattern);
          if (!label) continue;
          const value = row.words.find((w) => w.x > label.right && percent(w));
          const targetKey = desktopSources ? desktopKey(key) : key;
          if (value) put(targetKey, value, row);
          else warnings.push(`${screenshotFields[targetKey]}未能確定數值，請手動核對。`);
        }
    else warnings.push('流量來源未辨識出 Worldwide／All traffic，已略過該區塊。');
  }
  const result = { fields, months: [...months], warnings: [...new Set(warnings)] };
  if (includeSources) {
    result.sources = Object.fromEntries(Object.entries(sourceRegions).filter(([key]) => fields[key] !== undefined));
    if (Object.keys(uncertainRegions).length) result.uncertainSources = uncertainRegions;
    if (geography) {
      result.countryTable = true;
      const words = rows
        .filter((r) => r.center >= geography.center && (!geographyEnd || r.center < geographyEnd.center))
        .flatMap((r) => r.words);
      const x = Math.min(...words.map((w) => w.x)),
        y = Math.min(...words.map((w) => w.y));
      result.countryContexts = [
        {
          value: '國家表範圍，非精確辨識位置',
          x,
          y,
          w: Math.max(...words.map((w) => w.x + w.w)) - x,
          h: Math.max(...words.map((w) => w.y + w.h)) - y,
        },
      ];
    }
  }
  return result;
}

export function mergeScreenshots(results) {
  const fields = {},
    conflicts = new Set(),
    months = new Set(),
    warnings = [];
  for (const result of results) {
    for (const month of result.months) months.add(month);
    warnings.push(...result.warnings);
    for (const [key, value] of Object.entries(result.fields)) {
      if (fields[key] !== undefined && fields[key] !== value) conflicts.add(key);
      else fields[key] = value;
    }
  }
  for (const key of conflicts) {
    delete fields[key];
    warnings.push(`不同截圖的${screenshotFields[key]}不一致，請手動輸入。`);
  }
  const result = { fields, months: [...months], warnings: [...new Set(warnings)] };
  if (results.some((r) => r.sources)) {
    result.sources = {};
    for (const source of results)
      for (const [key, regions] of Object.entries(source.sources || {})) {
        if (fields[key] !== undefined) (result.sources[key] ||= []).push(...regions);
      }
    result.countryTable = results.some((r) => r.countryTable);
    const contexts = results.flatMap((r) => r.countryContexts || []);
    if (contexts.length) result.countryContexts = contexts;
    const uncertain = {};
    for (const source of results)
      for (const [key, regions] of Object.entries(source.sources || {})) if (conflicts.has(key)) (uncertain[key] ||= []).push(...regions);
    for (const source of results)
      for (const [key, regions] of Object.entries(source.uncertainSources || {})) {
        if (fields[key] === undefined) (uncertain[key] ||= []).push(...regions);
      }
    if (Object.keys(uncertain).length) result.uncertainSources = uncertain;
  }
  return result;
}
