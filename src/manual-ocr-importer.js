import { mergeScreenshots, parseScreenshot, screenshotFields } from './parser.js';

const host = document.getElementById('manual-import');
const fileInput = host.querySelector('input[type=file]');
const recognize = host.querySelector('[data-recognize]');
const progress = host.querySelector('[data-progress]');
const review = host.querySelector('[data-review]');
const form = document.querySelector('.manual-form');
const month = form.elements.namedItem('month');
const base = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
let busy = false;
const text = (tag, value, className = '') => {
  const node = document.createElement(tag);
  node.textContent = value;
  node.className = className;
  return node;
};
const loadEngine = () => {
  if (window.Tesseract) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = base + '/tesseract.min.js';
    script.onload = resolve;
    script.onerror = () => {
      script.remove();
      reject(Error('辨識工具載入失敗，請重新嘗試。'));
    };
    document.head.append(script);
  });
};
function createOcrWorker() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(Error('辨識工具準備逾時，請重新嘗試或改用手動輸入。')), 60_000);
    const finish = (error, worker) => {
      if (settled) {
        if (worker) worker.terminate().catch(() => {});
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(worker);
    };
    window.Tesseract.createWorker('eng', 1, {
      workerPath: base + '/worker.min.js',
      corePath: base + '/core',
      langPath: base + '/lang',
      workerBlobURL: false,
      errorHandler: (error) => finish(error || Error('辨識工具載入失敗，請重新嘗試。')),
    }).then(
      (worker) => finish(null, worker),
      (error) => finish(error),
    );
  });
}
async function imageCanvas(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024)
    throw Error('請選 PNG、JPG 或 WebP，每張最多 10 MB。');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 24_000_000)
      throw Error('圖片尺寸過大，請裁切到需要補登的區塊。');
    // Small platform text needs enlargement; cap the canvas for phones.
    const scale = Math.min(
      2,
      3000 / image.naturalWidth,
      4000 / image.naturalHeight,
      Math.sqrt(8_000_000 / (image.naturalWidth * image.naturalHeight)),
    );
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}
function showReview(result) {
  review.replaceChildren();
  if (result.months.length > 1) throw Error('截圖包含不同月份，請只選同一個月份的截圖。');
  const targetMonth = result.months[0] || month.value;
  if (![...month.options].some((o) => o.value === targetMonth)) throw Error('截圖月份超出可補登範圍，請確認日期。');
  const entries = Object.entries(result.fields).filter(([key]) => screenshotFields[key]);
  if (!entries.length) throw Error('沒有辨識到可補登的數值，請改用清楚的英文版概況、國家或流量來源截圖，也可直接手填。');
  const targetLabel = targetMonth.slice(0, 4) + '/' + targetMonth.slice(4);
  review.append(text('h3', '核對辨識結果'), text('p', '填入對象：' + host.dataset.domain + '・' + targetLabel));
  const warnings = [...result.warnings];
  if (!result.months.length) warnings.push('截圖未辨識出月份，目前使用表單選擇的月份，請確認。');
  warnings.push('截圖未必包含網域，請確認屬於上方網站。數值僅供核對，按「儲存」後才會生效。');
  for (const warning of warnings) review.append(text('p', warning, 'note'));
  const table = document.createElement('table');
  const head = document.createElement('thead'),
    heading = document.createElement('tr');
  for (const label of ['填入', '欄位', '截圖辨識', '目前內容']) heading.append(text('th', label, 'l'));
  head.append(heading);
  table.append(head);
  const tbody = document.createElement('tbody'),
    choices = [];
  // Read the target month's saved values or draft without changing the visible form.
  const current = () => {
    const detail = { month: targetMonth, values: null };
    form.dispatchEvent(new CustomEvent('manual:read-month', { detail }));
    if (!detail.values) throw Error('表單尚未就緒，請重新整理後再試。');
    return detail.values;
  };
  const before = current();
  for (const [key, value] of entries) {
    const row = document.createElement('tr'),
      cell = document.createElement('td'),
      check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = !before[key];
    check.setAttribute('aria-label', '填入' + screenshotFields[key]);
    cell.append(check);
    row.append(cell, text('td', screenshotFields[key]), text('td', value, 'ocr-value'), text('td', before[key] || '空白', 'ocr-value'));
    tbody.append(row);
    choices.push({ key, value, check, before: before[key] });
  }
  table.append(tbody);
  const scroll = text('div', '', 'scroll');
  scroll.append(table);
  review.append(scroll);
  review.append(text('p', '已有內容的欄位預設不覆寫；要替換時請勾選。', 'note'));
  const confirmation = document.createElement('label'),
    confirmed = document.createElement('input');
  confirmed.type = 'checkbox';
  confirmation.append(
    confirmed,
    document.createTextNode(' 我已確認截圖屬於 ' + host.dataset.domain + '、' + targetLabel + '，勾選資料為全球／全裝置範圍。'),
  );
  review.append(confirmation);
  const apply = text('button', '填入勾選欄位');
  apply.type = 'button';
  apply.disabled = true;
  confirmed.addEventListener('change', () => {
    apply.disabled = !confirmed.checked;
  });
  apply.addEventListener('click', () => {
    const selected = choices.filter((c) => c.check.checked);
    if (!selected.length) {
      progress.textContent = '請先勾選要填入的欄位。';
      return;
    }
    const latest = current();
    if (selected.some((c) => latest[c.key] !== c.before)) {
      progress.textContent = '核對期間表單內容已變更，請重新辨識並核對，避免覆蓋剛填的內容。';
      return;
    }
    if (month.value !== targetMonth) {
      month.value = targetMonth;
      month.dispatchEvent(new Event('change', { bubbles: true }));
    }
    for (const { key, value } of selected) form.elements.namedItem(key).value = value;
    form.dispatchEvent(new Event('input', { bubbles: true }));
    progress.textContent = '已填入 ' + selected.length + ' 個欄位，尚未儲存。請核對表單後按「儲存」。';
    review.replaceChildren();
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  review.append(apply);
}
recognize.addEventListener('click', async () => {
  if (busy) return;
  const files = [...fileInput.files];
  if (!files.length || files.length > 4) {
    progress.textContent = '請選擇 1–4 張同一網站、同一月份的截圖。';
    return;
  }
  busy = true;
  recognize.disabled = true;
  fileInput.disabled = true;
  review.replaceChildren();
  let worker;
  try {
    progress.textContent = '正在準備辨識工具，首次使用需下載辨識資料，請稍候…';
    await loadEngine();
    worker = await createOcrWorker();
    await worker.setParameters({ tessedit_pageseg_mode: '11' });
    const results = [];
    for (let i = 0; i < files.length; i++) {
      progress.textContent = '正在辨識第 ' + (i + 1) + '／' + files.length + ' 張截圖…';
      const canvas = await imageCanvas(files[i]);
      try {
        const { data } = await worker.recognize(canvas, {}, { text: true, tsv: true });
        results.push(parseScreenshot(data.tsv || ''));
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    showReview(mergeScreenshots(results));
    progress.textContent = '辨識完成，請核對下方結果；目前尚未更動表單。';
  } catch (error) {
    review.replaceChildren();
    progress.textContent =
      typeof error?.message === 'string' && /^[\u3400-\u9fff]/.test(error.message)
        ? error.message
        : '辨識失敗，請重新嘗試；若瀏覽器不支援辨識，也可使用下方表單手動輸入。';
  } finally {
    if (worker) await worker.terminate().catch(() => {});
    busy = false;
    recognize.disabled = false;
    fileInput.disabled = false;
  }
});
