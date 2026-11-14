import {
  mergeScreenshots,
  parseScreenshot,
  refineScreenshotNumbers,
  reviewScreenshotCountries,
  screenshotCountryCodes,
  screenshotFields,
} from './parser.js';

const host = document.getElementById('manual-import');
const fileInput = host.querySelector('input[type=file]');
const recognize = host.querySelector('[data-recognize]');
const progress = host.querySelector('[data-progress]');
const review = host.querySelector('[data-review]');
const form = document.querySelector('.manual-form');
const month = form.elements.namedItem('month');
const base = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
let busy = false;
let images = [];
let reviewDirty = false;
let pendingReview = false;
const saveBar = form.querySelector('.manual-save-bar');
const saveHint = saveBar.querySelector('span');
const defaultSaveHint = saveHint.textContent;
const saveWarning = document.createElement('div');
saveWarning.className = 'ocr-save-warning';
saveWarning.hidden = true;
saveBar.after(saveWarning);
function updateSaveHandoff(pending) {
  pendingReview = pending;
  form.dispatchEvent(new CustomEvent('manual:review-state', { detail: { pending } }));
  saveHint.textContent = pending ? '截圖核對尚未填入。請先返回核對，避免遺失修正。' : defaultSaveHint;
  for (const button of form.querySelectorAll('[type=submit]')) button.classList.toggle('primary', !pending);
  saveWarning.hidden = true;
}
form.addEventListener(
  'submit',
  (event) => {
    if (!pendingReview) {
      reviewDirty = false;
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const message = text('p', '尚未儲存：核對區的數值與修正還沒有填入表單。');
    message.setAttribute('role', 'alert');
    const back = text('button', '返回核對並填入', 'primary');
    back.type = 'button';
    back.addEventListener('click', () => host.querySelector('.ocr-review-shortcut button').click());
    const discard = text('button', '放棄這次核對，儲存表單目前內容');
    discard.type = 'button';
    discard.addEventListener('click', () => {
      updateSaveHandoff(false);
      reviewDirty = false;
      form.requestSubmit(event.submitter);
    });
    saveWarning.replaceChildren(message, back, discard);
    saveWarning.hidden = false;
    back.focus();
  },
  true,
);
window.addEventListener('beforeunload', (event) => {
  if (reviewDirty) {
    event.preventDefault();
    event.returnValue = '';
  }
});
function setStep(step) {
  for (const item of host.querySelectorAll('[data-step]')) {
    if (item.dataset.step === (step === 'recognize' ? 'select' : step)) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
    if (item.dataset.step === 'select') item.lastChild.textContent = step === 'recognize' ? ' 辨識中…' : ' 選擇截圖';
  }
}
function clearFormSources() {
  for (const field of form.querySelectorAll('[data-ocr-filled]')) {
    delete field.dataset.ocrFilled;
  }
  for (const button of form.querySelectorAll('.ocr-form-source')) button.remove();
}
form.addEventListener('change', (event) => {
  if (event.target === month) clearFormSources();
});
const text = (tag, value, className = '') => {
  const node = document.createElement(tag);
  node.textContent = value;
  node.className = className;
  return node;
};
function setStatus(message, error = false) {
  progress.textContent = message;
  progress.classList.toggle('is-error', error);
  progress.setAttribute('role', error ? 'alert' : 'status');
  progress.setAttribute('aria-live', error ? 'assertive' : 'polite');
}
const uploadTarget = text('p', '', 'ocr-upload-target');
const updateTarget = () => {
  uploadTarget.textContent = '補登對象：' + host.dataset.domain + ' · ' + month.value.slice(0, 4) + '/' + month.value.slice(4);
};
recognize.setAttribute('aria-describedby', progress.id || (progress.id = 'ocr-progress'));
updateTarget();
month.addEventListener('change', () => {
  if (!pendingReview) updateTarget();
});
host.querySelector('.ocr-upload-head').after(uploadTarget);
let pendingFiles = null;
let fileInitiator = null;
const fileDecision = text('div', '', 'ocr-file-decision');
fileDecision.hidden = true;
host.querySelector('[data-files]').after(fileDecision);
function renderFiles() {
  const list = host.querySelector('[data-files]');
  list.replaceChildren();
  for (const [index, image] of images.entries()) {
    const item = text('div', '', 'ocr-file');
    const thumbnail = new Image();
    thumbnail.src = image.url;
    thumbnail.alt = '';
    const info = text('div');
    info.append(text('b', '截圖 ' + (index + 1)), text('span', image.file.name));
    const remove = text('button', '移除');
    remove.type = 'button';
    remove.disabled = busy;
    remove.setAttribute('aria-label', '移除截圖 ' + (index + 1) + '：' + image.file.name);
    remove.addEventListener('click', () =>
      changeFiles(
        images.filter((entry) => entry !== image).map((entry) => entry.file),
        remove,
      ),
    );
    item.append(thumbnail, info, remove);
    list.append(item);
  }
  recognize.disabled = busy || !images.length;
}
function commitFiles(files, restoreFocus = true) {
  clearFormSources();
  const previous = images;
  images = files.map((file) => previous.find((entry) => entry.file === file) || { file, url: URL.createObjectURL(file) });
  for (const entry of previous) if (!images.includes(entry)) URL.revokeObjectURL(entry.url);
  review.replaceChildren();
  reviewDirty = false;
  updateSaveHandoff(false);
  fileDecision.hidden = true;
  pendingFiles = null;
  fileInput.value = '';
  renderFiles();
  setStatus(images.length ? '已選 ' + images.length + ' 張截圖，可繼續加入；按「辨識截圖」開始。' : '請選擇截圖。');
  recognize.textContent = '辨識截圖';
  recognize.classList.add('primary');
  if (restoreFocus) (host.querySelector('.ocr-file button') || fileInput).focus();
  setStep('select');
}
function changeFiles(files, initiator = fileInput) {
  if (busy) return;
  if (files.length > 4) {
    setStatus('最多 4 張截圖；目前已選 ' + images.length + ' 張，請先移除再加入。', true);
    return;
  }
  for (const file of files) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
      setStatus('「' + file.name + '」無法加入：請選 PNG、JPG 或 WebP，每張最多 10 MB。', true);
      return;
    }
  }
  if (review.childElementCount) {
    pendingFiles = files;
    fileInitiator = initiator;
    const removed = images.filter((entry) => !files.includes(entry.file)).map((entry) => entry.file.name);
    const description = text(
      'p',
      (removed.length
        ? '移除「' + removed.join('」、「') + '」。'
        : files.length > images.length
          ? '加入 ' + (files.length - images.length) + ' 張截圖。'
          : '重新辨識目前截圖。') + '需要重新核對，會清除這次修正；已填入的表單保留。',
    );
    description.id = 'ocr-file-decision-label';
    fileDecision.setAttribute('role', 'group');
    fileDecision.setAttribute('aria-labelledby', description.id);
    fileDecision.replaceChildren(description);
    setStatus('請確認是否更改截圖；目前核對仍保留。');
    const accept = text('button', removed.length ? '移除並重新核對' : '更改截圖並重新核對');
    const cancel = text('button', '保留截圖與核對');
    accept.type = cancel.type = 'button';
    accept.addEventListener('click', () => commitFiles(pendingFiles));
    cancel.addEventListener('click', () => {
      pendingFiles = null;
      fileDecision.hidden = true;
      fileInput.value = '';
      setStatus('已保留截圖與核對修正，可繼續核對。');
      (fileInitiator?.isConnected ? fileInitiator : fileInput).focus();
    });
    fileDecision.append(accept, cancel);
    fileDecision.onkeydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel.click();
      }
    };
    fileDecision.hidden = false;
    cancel.focus();
  } else commitFiles(files, initiator !== fileInput);
}
function selectFiles() {
  const picked = [...fileInput.files];
  const additions = picked.filter((file) => !images.some((entry) => entry.file.name === file.name && entry.file.size === file.size));
  const rejected = additions.filter(
    (file) => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024,
  );
  const valid = additions.filter((file) => !rejected.includes(file));
  const remaining = 4 - images.length;
  const accepted = valid.slice(0, remaining);
  const skipped = valid.slice(remaining);
  if (accepted.length) changeFiles([...images.map((entry) => entry.file), ...accepted]);
  const notes = [];
  if (rejected.length)
    notes.push('未加入「' + rejected.map((file) => file.name).join('」、「') + '」：只支援 PNG、JPG、WebP，每張最多 10 MB。');
  if (skipped.length) notes.push('最多 4 張，另有 ' + skipped.length + ' 張未加入；請先移除不需要的截圖。');
  if (picked.length > additions.length) notes.push('略過 ' + (picked.length - additions.length) + ' 張重複截圖。');
  if (notes.length)
    setStatus(
      (accepted.length ? (pendingFiles ? '待確認加入 ' : '已加入 ') + accepted.length + ' 張有效截圖；' : '') + notes.join(' '),
      Boolean(rejected.length || skipped.length),
    );
  fileInput.value = '';
}
fileInput.addEventListener('change', selectFiles);
const dropzone = host.querySelector('[data-dropzone]');
for (const event of ['dragenter', 'dragover'])
  dropzone.addEventListener(event, (e) => {
    e.preventDefault();
    if (!busy) dropzone.classList.add('is-dragging');
  });
for (const event of ['dragleave', 'drop'])
  dropzone.addEventListener(event, (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-dragging');
  });
dropzone.addEventListener('drop', (e) => {
  if (busy || !e.dataTransfer.files.length) return;
  fileInput.files = e.dataTransfer.files;
  selectFiles();
});
renderFiles();
setStatus('先選擇截圖，再開始辨識。');
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
      logger: (event) => {
        if (
          !busy ||
          !['loading tesseract core', 'initializing tesseract', 'loading language traineddata', 'initializing api'].includes(event.status)
        )
          return;
        const stage = event.status === 'loading language traineddata' ? '正在下載英文辨識資料' : '正在準備辨識工具';
        const percent = Number.isFinite(event.progress) ? ' ' + Math.round(event.progress * 100) + '%' : '';
        progress.textContent = stage + percent + '；首次使用需下載，之後會使用瀏覽器快取。';
      },
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

async function recognizeCanvas(canvas, worker, mode) {
  await worker.setParameters({ tessedit_pageseg_mode: mode, tessedit_char_whitelist: '' });
  try {
    const { data } = await worker.recognize(canvas, {}, { text: true, tsv: true });
    await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789.%<>≤≥' });
    const refined = await refineScreenshotNumbers(data.tsv || '', async ({ x, y, w, h }) => {
      const padding = h * 0.4;
      const left = Math.max(0, x - padding),
        top = Math.max(0, y - padding);
      const width = Math.min(canvas.width - left, w + padding * 2),
        height = Math.min(canvas.height - top, h + padding * 2);
      const crop = document.createElement('canvas');
      crop.width = Math.round(width * 2);
      crop.height = Math.round(height * 2);
      try {
        const context = crop.getContext('2d');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, crop.width, crop.height);
        context.drawImage(canvas, left, top, width, height, 0, 0, crop.width, crop.height);
        const { data } = await worker.recognize(crop, {}, { tsv: true });
        return data.tsv || '';
      } finally {
        crop.width = 0;
        crop.height = 0;
      }
    });
    return refined;
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: '' });
  }
}
function sameValue(key, left, right) {
  const normalize = (value) => {
    if (!value) return '';
    if (key === 'countries')
      return value
        .trim()
        .toUpperCase()
        .split('\n')
        .map((line) => {
          const [code, share] = line.trim().split(/\s+/);
          return code + ' ' + Number(share?.replace(/%$/, ''));
        })
        .sort()
        .join('\n');
    if (key === 'duration' && value.includes(':')) return value.split(':').reduce((sum, piece) => sum * 60 + Number(piece), 0);
    if (key === 'visits') {
      const match = /^([\d.,]+)([KMB]?)$/i.exec(value.trim());
      if (match) return Number(match[1].replace(/,/g, '')) * ({ K: 1e3, M: 1e6, B: 1e9 }[match[2].toUpperCase()] || 1);
    }
    const number = Number(value.replace(/%$/, ''));
    return Number.isFinite(number) ? number : value.trim();
  };
  return normalize(left) === normalize(right);
}
function showReview(result) {
  review.replaceChildren();
  if (result.months.length > 1) throw Error('截圖包含不同月份，請只選同一個月份的截圖。');
  const targetMonth = result.months[0] || month.value;
  if (![...month.options].some((o) => o.value === targetMonth)) throw Error('截圖月份超出可補登範圍，請確認日期。');
  const entries = Object.entries(result.fields).filter(([key]) => screenshotFields[key]);
  const missingTaiwan = result.countryTable && result.fields.taiwan === undefined;
  if (missingTaiwan) entries.push(['taiwan', '']);
  if (result.countryTable && !result.fields.countries) entries.push(['countries', '']);
  for (const [key, label] of Object.entries(screenshotFields)) {
    if (
      !entries.some(([k]) => k === key) &&
      result.warnings.some((warning) => {
        const message = warning.replace(/^截圖 \d+：/, '');
        return (message.startsWith(label) || message.startsWith('不同截圖的' + label)) && /不一致|不夠清楚|未能確定/.test(message);
      })
    )
      entries.push([key, '']);
  }
  if (['visits', 'pages', 'duration', 'bounce'].filter((key) => result.fields[key] !== undefined).length >= 2) {
    for (const key of ['visits', 'pages', 'duration', 'bounce']) if (!entries.some(([entry]) => entry === key)) entries.push([key, '']);
  }
  if (!entries.length) throw Error('沒有辨識到可補登的數值，請改用清楚的英文版概況、國家或流量來源截圖，也可直接手填。');
  const targetLabel = targetMonth.slice(0, 4) + '/' + targetMonth.slice(4);
  uploadTarget.textContent = '核對對象：' + host.dataset.domain + ' · ' + targetLabel + '（截圖月份優先）';
  const omittedCountries = [
    ...new Set([...(missingTaiwan ? ['台灣'] : []), ...result.warnings.map((w) => /國家占比（([^）]+)）/.exec(w)?.[1]).filter(Boolean)]),
  ];
  const countryIncomplete = Boolean(
    result.countryTable && (missingTaiwan || result.warnings.some((w) => /國家.*(?:漏辨識|不夠清楚|未能確定|不一致|超過)/.test(w))),
  );
  updateSaveHandoff(true);
  const heading = text('div', '', 'ocr-review-heading');
  heading.tabIndex = -1;
  const title = text('div');
  title.append(
    text('h3', '核對辨識結果'),
    text('p', host.dataset.domain + ' · ' + targetLabel + (result.months.length ? '（截圖月份）' : '（沿用表單，請確認）'), 'ocr-target'),
  );
  const count = text('span', '', 'ocr-count');
  heading.append(title, count);
  review.append(heading);
  let countryNotice;
  const warnings = [...result.warnings];
  if (!result.months.length) warnings.push('未讀到月份，目前使用表單月份 ' + targetLabel + '，請確認。');
  if (missingTaiwan) warnings.unshift('台灣占比未讀到，請對照原圖手動補上；不會用其他國家的剩餘占比推算。');
  if (warnings.length) {
    const notice = text('div', '', 'ocr-notices');
    const scopeImages = [
      ...new Set(
        warnings
          .filter((w) => /未完整辨識出 Worldwide/.test(w))
          .map((w) => /^截圖 (\d+)/.exec(w)?.[1])
          .filter(Boolean),
      ),
    ];
    if (scopeImages.length)
      notice.append(text('p', '範圍待確認：截圖 ' + scopeImages.join('、') + '。請核對全球／全裝置；桌面渠道分開儲存。'));
    if (!result.months.length) notice.append(text('p', '未讀到月份：沿用表單 ' + targetLabel + '，請確認與截圖相符。'));
    if (countryIncomplete) {
      countryNotice = text('p', (missingTaiwan ? '台灣占比未讀到；' : '') + '國家表尚未完整讀到，請在「國家分布」補齊或明確接受現有列表。');
      notice.append(countryNotice);
    }
    const details = document.createElement('details');
    details.append(text('summary', '完整辨識提示（' + warnings.length + '）'));
    for (const warning of warnings) details.append(text('p', warning));
    notice.append(details);
    review.append(notice);
  }
  const workspace = text('div', '', 'ocr-workspace');
  const viewer = text('section', '', 'ocr-viewer');
  viewer.setAttribute('aria-label', '截圖來源');
  const viewerHead = text('div', '', 'ocr-panel-head');
  viewerHead.append(text('h4', '原始截圖'), text('span', '點欄位可定位原圖', 'note'));
  const tabs = text('div', '', 'ocr-image-tabs');
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', '選擇來源截圖');
  const caption = text('p', '', 'ocr-image-caption');
  const controls = text('div', '', 'ocr-view-controls');
  const zoom = text('button', '放大');
  zoom.type = 'button';
  zoom.setAttribute('aria-pressed', 'false');
  const markerLabel = document.createElement('label'),
    markerToggle = document.createElement('input');
  markerToggle.type = 'checkbox';
  markerToggle.checked = true;
  markerLabel.append(markerToggle, document.createTextNode(' 顯示標記'));
  controls.append(markerLabel, zoom);
  const viewport = text('div', '', 'ocr-image-viewport');
  viewport.tabIndex = 0;
  viewport.setAttribute('role', 'region');
  viewport.setAttribute('aria-label', '原圖檢視區，可捲動查看');
  const stage = text('div', '', 'ocr-image-stage');
  const original = new Image();
  original.draggable = false;
  const overlay = text('div', '', 'ocr-overlay');
  stage.append(original, overlay);
  viewport.append(stage);
  const focusLabel = text('p', '點選右側欄位，查看對應截圖與橘色標記。', 'ocr-focus-label');
  viewer.append(viewerHead, tabs, caption, controls, viewport, focusLabel);
  const sourceDisclosure = document.createElement('details');
  sourceDisclosure.className = 'ocr-source-disclosure';
  sourceDisclosure.open = !matchMedia('(max-width: 760px)').matches;
  sourceDisclosure.append(text('summary', '查看完整原圖與切換截圖'), viewer);
  workspace.append(sourceDisclosure);
  const right = text('section', '', 'ocr-results');
  right.setAttribute('aria-label', '辨識欄位與填入位置');
  const resultHead = text('div', '', 'ocr-panel-head');
  const selectionCount = text('span', '', 'ocr-selection-count');
  selectionCount.setAttribute('aria-live', 'polite');
  resultHead.append(text('h4', '辨識值 → 表單欄位'), selectionCount);
  right.append(resultHead, text('p', '勾選要填入的欄位；可直接修正數值。已有內容預設保留。', 'ocr-results-hint'));
  workspace.append(right);
  const navigation = text('nav', '', 'ocr-section-nav');
  navigation.setAttribute('aria-label', '核對欄位分類');
  const categorySelect = document.createElement('select');
  categorySelect.className = 'ocr-category-select';
  categorySelect.setAttribute('aria-label', '跳到核對分類');
  categorySelect.addEventListener('change', () => revealChoice(choices.find((choice) => choice.key === categorySelect.value)));
  navigation.append(categorySelect);
  review.append(navigation, workspace);
  const current = () => {
    const detail = { month: targetMonth, values: null };
    form.dispatchEvent(new CustomEvent('manual:read-month', { detail }));
    if (!detail.values) throw Error('表單尚未就緒，請重新整理後再試。');
    return detail.values;
  };
  const before = current(),
    choices = [];
  let countryAcknowledgement, returnToForm;
  let modeChosen = false;
  const phoneQuery = matchMedia('(max-width: 760px)');
  let singleField = phoneQuery.matches;
  const modeButton = text('button', '');
  modeButton.type = 'button';
  modeButton.className = 'ocr-mode-toggle';
  const fieldPosition = text('span', '', 'ocr-field-position');
  fieldPosition.setAttribute('aria-live', 'polite');
  const modeBar = text('div', '', 'ocr-mode-bar');
  modeBar.append(modeButton, fieldPosition);
  right.querySelector('.ocr-results-hint').after(modeBar);
  const setMode = () => {
    right.classList.toggle('is-single-field', singleField);
    modeButton.textContent = singleField ? '顯示全部欄位' : '逐欄核對';
    modeButton.setAttribute('aria-pressed', String(singleField));
    const bulk = right.querySelector('.ocr-bulk-tools');
    if (bulk && !modeChosen) bulk.open = !singleField;
  };
  modeButton.addEventListener('click', () => {
    modeChosen = true;
    singleField = !singleField;
    setMode();
  });
  phoneQuery.addEventListener('change', () => {
    sourceDisclosure.open = !phoneQuery.matches;
    if (!modeChosen) {
      singleField = phoneQuery.matches;
      setMode();
    }
  });
  setMode();
  let nextAfter;
  const stepButtons = [];
  let activeKey = '',
    activeImage = 0,
    applied = false,
    stale = false;
  const imageButtons = images.map((image, index) => {
    const button = text('button', '截圖 ' + (index + 1));
    button.type = 'button';
    button.title = image.file.name;
    button.addEventListener('click', () => {
      activeImage = index;
      renderImage();
    });
    tabs.append(button);
    return button;
  });
  function regionsFor(key) {
    const precise = result.sources?.[key] || [];
    const uncertain = result.uncertainSources?.[key] || [];
    if (precise.length && !(key === 'countries' && countryIncomplete)) return precise;
    if (uncertain.length) return uncertain.map((r) => ({ ...r, context: '待核對位置 · 辨識值 ' + r.value + '，尚未採用' }));
    if (['taiwan', 'countries'].includes(key))
      return (result.countryContexts || []).map((r) => ({ ...r, context: '國家表上下文，非精確辨識位置' }));
    return precise;
  }
  function revealChoice(choice) {
    selectField(choice.key);
    choice.input.focus({ preventScroll: true });
    requestAnimationFrame(() => choice.row.scrollIntoView({ block: 'nearest' }));
  }
  function selectField(key, move = true, imageIndex) {
    activeKey = key;
    const currentIndex = choices.findIndex((choice) => choice.key === key);
    if (nextAfter) nextAfter.textContent = currentIndex === choices.length - 1 ? '完成逐欄核對 →' : '核對下一欄 →';
    for (const [step, direction] of stepButtons) {
      step.disabled = direction === -1 && currentIndex === 0;
      if (direction === 1) step.textContent = currentIndex === choices.length - 1 ? '前往確認' : '下一欄';
    }
    for (const option of categorySelect.options) {
      const group = choices.find((choice) => choice.key === option.value)?.row.parentElement;
      if (group === choices[currentIndex]?.row.parentElement) categorySelect.value = option.value;
    }
    fieldPosition.textContent = '第 ' + (choices.findIndex((choice) => choice.key === key) + 1) + '／' + choices.length + ' 欄';
    const regions = regionsFor(key);
    if (imageIndex !== undefined) activeImage = imageIndex;
    else if (regions.length) activeImage = regions[0].image;
    for (const choice of choices) {
      choice.row.classList.toggle('is-active', choice.key === key);
      choice.evidence.hidden = choice.key !== key;
    }
    renderEvidence();
    const active = choices.find((choice) => choice.key === key);
    if (active && document.activeElement === active.input) requestAnimationFrame(() => active.row.scrollIntoView({ block: 'nearest' }));
    renderImage();
    if (move)
      requestAnimationFrame(() => {
        const marker = overlay.querySelector('.is-active');
        if (marker) {
          // Scroll only the image pane, keeping the result field in view.
          viewport.scrollTop = Math.max(0, marker.offsetTop - viewport.clientHeight * 0.35);
          viewport.scrollLeft = stage.classList.contains('is-zoomed')
            ? Math.max(0, marker.offsetLeft + marker.offsetWidth - viewport.clientWidth + 16)
            : Math.max(0, marker.offsetLeft - viewport.clientWidth * 0.2);
        }
      });
  }
  function renderImage() {
    const image = images[activeImage];
    original.width = image.width;
    original.height = image.height;
    original.style.aspectRatio = image.width + ' / ' + image.height;
    if (original.src !== image.url) original.src = image.url;
    original.alt = '截圖 ' + (activeImage + 1) + '：' + image.file.name;
    caption.textContent = image.file.name;
    imageButtons.forEach((button, index) => {
      button.setAttribute('aria-pressed', String(index === activeImage));
    });
    overlay.replaceChildren();
    const markers = new Map();
    for (const choice of choices)
      for (const region of regionsFor(choice.key)) {
        if (region.image !== activeImage) continue;
        // Taiwan and its country-list entry share a box; show one active marker.
        const id = [region.x, region.y, region.w, region.h].join(':');
        if (markers.has(id) && choice.key !== activeKey) continue;
        const marker = text('button', '', 'ocr-marker' + (choice.key === activeKey ? ' is-active' : ''));
        marker.type = 'button';
        marker.tabIndex = -1;
        marker.setAttribute('aria-label', '查看' + screenshotFields[choice.key] + '：' + region.value);
        marker.title = screenshotFields[choice.key] + ' · ' + region.value;
        marker.style.left = Math.max(0, ((region.x - 8) / image.width) * 100) + '%';
        marker.style.top = Math.max(0, ((region.y - 6) / image.height) * 100) + '%';
        marker.style.width = Math.min(100, ((region.w + 16) / image.width) * 100) + '%';
        marker.style.height = ((region.h + 12) / image.height) * 100 + '%';
        marker.addEventListener('click', () => {
          selectField(choice.key, false, activeImage);
          choice.input.focus({ preventScroll: true });
          choice.row.scrollIntoView({ block: 'nearest' });
        });
        markers.get(id)?.remove();
        markers.set(id, marker);
        overlay.append(marker);
      }
    const label = screenshotFields[activeKey];
    const linked = regionsFor(activeKey).some((s) => s.image === activeImage);
    focusLabel.textContent = label
      ? label + (linked ? ' · 橘框為辨識來源，請對照數字。' : ' · 這張截圖沒有可定位的辨識來源。')
      : '點選右側欄位，查看對應截圖與橘色標記。';
  }
  function renderEvidence() {
    const choice = choices.find((entry) => entry.key === activeKey);
    if (!choice) return;
    choice.evidence.replaceChildren();
    const regions = regionsFor(activeKey);
    if (!regions.length) {
      choice.evidence.append(text('p', '沒有精確來源，請查看原圖後補正。'));
      appendFullImageAction(choice.evidence, choice);
      return;
    }
    const byImage = new Map();
    for (const region of regions) {
      const list = byImage.get(region.image) || [];
      list.push(region);
      byImage.set(region.image, list);
    }
    for (const [index, list] of byImage) {
      const source = images[index];
      const left = Math.max(0, Math.min(...list.map((r) => r.x)) - 24);
      const top = Math.max(0, Math.min(...list.map((r) => r.y)) - 12);
      const width = Math.min(source.width - left, Math.max(...list.map((r) => r.x + r.w)) - left + 24);
      const height = Math.min(source.height - top, Math.max(...list.map((r) => r.y + r.h)) - top + 12);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width);
      canvas.height = Math.round(height);
      canvas.setAttribute('role', 'img');
      canvas.setAttribute(
        'aria-label',
        '截圖 ' + (index + 1) + ' 原圖局部：' + screenshotFields[activeKey] + '，辨識值 ' + list.map((r) => r.value).join('、'),
      );
      const sourceImage = new Image();
      sourceImage.onload = () => {
        canvas
          .getContext('2d')
          .drawImage(
            sourceImage,
            (left / source.width) * sourceImage.naturalWidth,
            (top / source.height) * sourceImage.naturalHeight,
            (width / source.width) * sourceImage.naturalWidth,
            (height / source.height) * sourceImage.naturalHeight,
            0,
            0,
            canvas.width,
            canvas.height,
          );
      };
      sourceImage.src = source.url;
      const cropHead = text('div', '', 'ocr-crop-head');
      cropHead.append(text('span', '截圖 ' + (index + 1) + ' · ' + (list[0].context || '原圖局部')));
      if (choice.conflict && !applied && choice.key !== 'countries') {
        const adopt = text('button', '採用截圖 ' + (index + 1) + ' 的 ' + list[0].value, 'ocr-adopt-source');
        adopt.type = 'button';
        adopt.addEventListener('click', () => {
          choice.input.value = list[0].value;
          choice.input.dispatchEvent(new Event('input', { bubbles: true }));
          revealChoice(choice);
        });
        cropHead.append(adopt);
      }
      appendFullImageAction(cropHead, choice, index);
      choice.evidence.append(cropHead, canvas);
    }
  }
  function appendFullImageAction(container, choice, index = activeImage) {
    const open = text('button', '查看原圖 ↗', 'ocr-full-image');
    open.type = 'button';
    open.addEventListener('click', () => {
      const dialog = document.createElement('dialog');
      dialog.className = 'ocr-original-dialog';
      dialog.setAttribute('aria-label', screenshotFields[choice.key] + '的完整來源截圖');
      const toolbar = text('div', '', 'ocr-dialog-toolbar');
      const close = text('button', applied ? '返回核對結果' : '返回' + screenshotFields[choice.key] + '補正');
      close.type = 'button';
      const enlarge = text('button', '放大原圖');
      enlarge.type = 'button';
      enlarge.setAttribute('aria-pressed', 'false');
      toolbar.append(text('strong', '截圖 ' + (index + 1) + ' · ' + images[index].file.name), enlarge, close);
      const img = new Image();
      img.src = images[index].url;
      img.alt = '完整來源截圖 ' + (index + 1);
      const body = text('div', '', 'ocr-dialog-image');
      const dialogStage = text('div', '', 'ocr-dialog-stage');
      dialogStage.append(img);
      const sourceRegions = regionsFor(choice.key).filter((region) => region.image === index);
      for (const region of sourceRegions) {
        const marker = text('span', '', 'ocr-dialog-marker');
        marker.style.left = (Math.max(0, region.x - 16) / images[index].width) * 100 + '%';
        marker.style.top = (Math.max(0, region.y - 16) / images[index].height) * 100 + '%';
        marker.style.width = (Math.min(images[index].width - Math.max(0, region.x - 16), region.w + 32) / images[index].width) * 100 + '%';
        marker.style.height = ((region.h + 32) / images[index].height) * 100 + '%';
        dialogStage.append(marker);
      }
      body.append(dialogStage);
      const panHint = text('p', '放大後可左右捲動，查看原圖文字與數值。', 'ocr-dialog-hint');
      enlarge.addEventListener('click', () => {
        const expanded = dialogStage.classList.toggle('is-zoomed');
        enlarge.setAttribute('aria-pressed', String(expanded));
        enlarge.textContent = expanded ? '符合寬度' : '放大原圖';
        const region = regionsFor(choice.key).find((r) => r.image === index);
        requestAnimationFrame(() => {
          body.scrollLeft =
            expanded && region ? Math.max(0, ((region.x + region.w) / images[index].width) * img.clientWidth - body.clientWidth + 16) : 0;
          body.scrollTop =
            expanded && region ? Math.max(0, (region.y / images[index].height) * img.clientHeight - body.clientHeight * 0.2) : 0;
        });
      });
      dialog.append(toolbar, panHint, body);
      review.append(dialog);
      close.addEventListener('click', () => dialog.close());
      dialog.addEventListener('close', () => {
        dialog.remove();
        revealChoice(choice);
      });
      dialog.showModal();
      close.focus();
      img
        .decode()
        .then(() => {
          const region = sourceRegions[0];
          if (region) body.scrollTop = Math.max(0, (region.y / images[index].height) * img.clientHeight - body.clientHeight * 0.25);
        })
        .catch(() => {});
    });
    container.append(open);
  }
  const resizeObserver = new ResizeObserver(() => {
    if (review.contains(workspace)) selectField(activeKey);
    else resizeObserver.disconnect();
  });
  resizeObserver.observe(viewport);
  markerToggle.addEventListener('change', () => {
    overlay.hidden = !markerToggle.checked;
  });
  zoom.addEventListener('click', () => {
    const expanded = stage.classList.toggle('is-zoomed');
    zoom.textContent = expanded ? '符合寬度' : '放大';
    zoom.setAttribute('aria-pressed', String(expanded));
    selectField(activeKey);
  });
  const groups = [
    ['概況與互動', (key) => ['visits', 'bounce', 'pages', 'duration'].includes(key)],
    ['國家分布', (key) => ['taiwan', 'countries'].includes(key)],
    [
      '全裝置流量來源',
      (key) => !['visits', 'bounce', 'pages', 'duration', 'taiwan', 'countries'].includes(key) && !key.startsWith('desktop_'),
    ],
    ['桌面限定流量來源', (key) => key.startsWith('desktop_')],
  ];
  for (const [label, matches] of groups) {
    const fields = entries.filter(([key]) => matches(key));
    if (!fields.length) continue;
    const section = text('div', '', 'ocr-field-group');
    const jump = text('button', label + ' ' + fields.length);
    jump.type = 'button';
    jump.addEventListener('click', () => {
      selectField(fields[0][0]);
      choices.find((choice) => choice.key === fields[0][0]).input.focus();
    });
    jump.className = 'ocr-category-button';
    const option = document.createElement('option');
    option.value = fields[0][0];
    option.textContent = label + '（' + fields.length + '欄）';
    categorySelect.append(option);
    navigation.append(jump);
    section.append(text('h4', label + (label === '桌面限定流量來源' ? ' · Desktop Only' : '')));
    if (label === '桌面限定流量來源') section.append(text('p', '僅占桌面造訪，不換算全裝置次數。', 'ocr-group-note'));
    right.append(section);
    for (const [key, value] of fields) {
      const row = text('div', '', 'ocr-field-row');
      row.dataset.field = key;
      const check = document.createElement('input');
      check.type = 'checkbox';
      const conflict = result.warnings.some((warning) => warning.includes('不同截圖的' + screenshotFields[key] + '不一致'));
      const needsReview = !value || (key === 'countries' && countryIncomplete);
      check.checked = Boolean(value) && !before[key] && !needsReview;
      check.setAttribute('aria-label', '填入' + screenshotFields[key]);
      const content = text('div', '', 'ocr-field-content');
      const sourceButton = text('button', screenshotFields[key], 'ocr-field-label');
      sourceButton.type = 'button';
      sourceButton.tabIndex = -1;
      sourceButton.setAttribute('aria-label', '定位' + screenshotFields[key]);
      const imageIndexes = [...new Set(regionsFor(key).map((s) => s.image))];
      const sourceLinks = text('div', '', 'ocr-field-sources');
      for (const index of imageIndexes) {
        const link = text(
          imageIndexes.length === 1 ? 'span' : 'button',
          '截圖 ' + (index + 1) + (imageIndexes.length === 1 ? '' : ' ↖'),
          imageIndexes.length === 1 ? 'ocr-source-caption' : 'ocr-source-link',
        );
        link.type = 'button';
        link.setAttribute('aria-label', screenshotFields[key] + '的截圖 ' + (index + 1));
        if (imageIndexes.length > 1) link.addEventListener('click', () => selectField(key, true, index));
        sourceLinks.append(link);
      }
      if (!imageIndexes.length) sourceLinks.append(text('span', '需補正 · 請對照原圖', 'ocr-missing'));
      const line = text('div', '', 'ocr-field-topline');
      line.append(sourceButton, sourceLinks);
      const editorLine = text('div', '', 'ocr-field-values');
      const input = document.createElement(key === 'countries' ? 'textarea' : 'input');
      input.value = value;
      input.id = 'ocr-edit-' + key;
      input.setAttribute('aria-label', '核對' + screenshotFields[key]);
      input.autocomplete = 'off';
      input.spellcheck = false;
      if (key === 'countries') input.rows = Math.max(3, value.split('\n').length);
      else input.inputMode = ['visits', 'duration'].includes(key) ? 'text' : 'decimal';
      if (!value) input.placeholder = conflict ? '數值不一致，請核對後選用或填寫' : '未讀到，請手動填寫';
      const unit = !['visits', 'pages', 'duration', 'countries'].includes(key) ? '%' : key === 'pages' ? '頁' : '';
      const inputWrap = text('div', '', 'ocr-edit-value');
      inputWrap.append(input);
      if (unit) inputWrap.append(text('span', unit, 'ocr-unit'));
      const previous = text('span', before[key] ? '目前：' + before[key] + (unit ? unit : '') : '', 'ocr-previous');
      editorLine.append(inputWrap, previous);
      const status = text(
        'span',
        key === 'countries' && countryIncomplete
          ? '列表不完整' +
              (omittedCountries.length ? '，待核對：' + omittedCountries.join('、') : '') +
              '。請對照原圖補齊；若只填部分國家，還需另行確認。'
          : before[key]
            ? '已有內容，預設保留'
            : value
              ? ''
              : conflict
                ? '不同截圖的辨識值不一致，請對照下方原圖後選用或填寫。'
                : '未讀到，不會自動填入',
        'ocr-field-status',
      );
      status.id = 'ocr-status-' + key;
      input.setAttribute('aria-describedby', status.id);
      check.setAttribute('aria-describedby', status.id);
      const evidence = text('div', '', 'ocr-inline-evidence' + (['taiwan', 'countries'].includes(key) ? ' is-country-evidence' : ''));
      evidence.hidden = true;
      content.append(line, evidence, editorLine, status);
      const hit = text('label', '', 'ocr-check-hit');
      hit.append(check);
      row.append(hit, content);
      section.append(row);
      const choice = {
        key,
        value,
        check,
        before: before[key],
        row,
        input,
        status,
        sourceButton,
        evidence,
        previous,
        needsReview,
        unit,
        selectionTouched: false,
        conflict,
      };
      choices.push(choice);
      sourceButton.addEventListener('click', () => revealChoice(choice));
      if (key === 'countries') {
        const hint = text('small', '每行：TW 93.23（兩碼國家代碼＋百分比）', 'ocr-country-hint');
        hint.id = 'ocr-country-format';
        content.append(hint);
        input.setAttribute('aria-describedby', status.id + ' ' + hint.id);
        if (countryIncomplete) {
          const acceptPartial = document.createElement('input');
          acceptPartial.type = 'checkbox';
          const partialText = text('span');
          const partialLabel = text('label', '', 'ocr-partial-confirmation');
          partialLabel.append(acceptPartial, partialText);
          content.append(partialLabel);
          countryAcknowledgement = acceptPartial;
          const expectedCodes = omittedCountries
            .map((name) => screenshotCountryCodes[name] || (/^[A-Z]{2}$/.test(name) ? name : ''))
            .filter(Boolean);
          const originalCount = value.split('\n').filter(Boolean).length;
          choice.updateCountry = () => {
            if (applied) return;
            const lines = choice.value.split('\n').filter(Boolean);
            const codes = lines.map((line) => line.trim().split(/\s+/)[0].toUpperCase());
            const taiwan = choices.find((entry) => entry.key === 'taiwan');
            const addedTaiwan = taiwan?.check.checked && taiwan.value && !codes.includes('TW');
            const missing = expectedCodes.filter((code) => !codes.includes(code) && !(code === 'TW' && addedTaiwan));
            const partial = missing.length || lines.length + (addedTaiwan ? 1 : 0) < originalCount + omittedCountries.length;
            const coverage =
              lines.reduce((sum, line) => sum + (Number(line.trim().split(/\s+/)[1]?.replace(/%$/, '')) || 0), 0) +
              (addedTaiwan ? Number(taiwan.value) || 0 : 0);
            partialLabel.hidden = !partial || applied;
            const omissions = missing.length ? '不含 ' + missing.join('、') : '可能有未列國家';
            partialText.textContent =
              '我已對照原圖，仍決定只填入這份不完整列表（' + omissions + '；合計 ' + coverage.toFixed(2) + '%）。缺少國家不會自動補上。';
            choice.needsReview = !choice.value || Boolean(partial && !acceptPartial.checked);
            status.textContent = partial
              ? '列表不完整：' + omissions + '，目前合計 ' + coverage.toFixed(2) + '%。請補齊，或明確確認只填入部分國家。'
              : '已補齊已知漏辨識的國家，請核對占比。';
          };
          acceptPartial.addEventListener('change', () => {
            reviewDirty = true;
            updateSelection();
          });
        }
      }
      input.addEventListener('focus', () => selectField(key));
      input.addEventListener('input', () => {
        input.removeAttribute('aria-invalid');
        choice.value = input.value.trim();
        if (!['visits', 'duration', 'countries', 'pages'].includes(key)) {
          choice.value = choice.value.replace(/%$/, '').trim();
          input.value = choice.value;
        }
        reviewDirty = true;
        if (countryAcknowledgement) countryAcknowledgement.checked = false;
        choice.needsReview = !choice.value;
        if (!choice.before && !choice.selectionTouched) check.checked = Boolean(choice.value);
        status.textContent =
          choice.before && !check.checked
            ? '修正已保留；勾選左側才會覆寫目前內容'
            : choice.value === value
              ? ''
              : '已手動修正 · 請對照原圖';
        updateSelection();
      });
      check.addEventListener('change', () => {
        choice.selectionTouched = true;
        if (countryAcknowledgement) countryAcknowledgement.checked = false;
        status.textContent =
          check.checked && choice.before
            ? '將覆寫目前內容：' + choice.before
            : choice.before
              ? '保留目前內容'
              : choice.needsReview
                ? '請對照原圖補齊未讀到的國家。'
                : '';
        updateSelection();
      });
    }
  }
  const afterField = text('div', '', 'ocr-after-field');
  nextAfter = text('button', '核對下一欄 →');
  nextAfter.type = 'button';
  function advanceField(direction) {
    const index = choices.findIndex((choice) => choice.key === activeKey) + direction;
    if (index >= choices.length) {
      confirmed.focus();
      confirmed.scrollIntoView({ block: 'center' });
      return;
    }
    revealChoice(choices[Math.max(0, index)]);
  }
  nextAfter.addEventListener('click', () => advanceField(1));
  afterField.append(nextAfter);
  right.append(afterField);
  const tools = text('div', '', 'ocr-selection-tools');
  for (const [label, predicate] of [
    ['勾選空白欄位', (choice) => Boolean(choice.value) && !choice.before && !choice.needsReview],
    [
      '勾選與目前不同的欄位',
      (choice) =>
        Boolean(choice.before) && Boolean(choice.value) && !choice.needsReview && !sameValue(choice.key, choice.value, choice.before),
    ],
    ['全部取消', () => false],
  ]) {
    const button = text('button', label);
    button.type = 'button';
    button.addEventListener('click', () => {
      for (const choice of choices) {
        choice.check.checked = predicate(choice);
        choice.selectionTouched = true;
      }
      updateSelection();
    });
    tools.append(button);
  }
  const jumpMissing = text('button', '', 'ocr-jump-missing');
  jumpMissing.type = 'button';
  jumpMissing.addEventListener('click', () => {
    const unresolved = choices.filter((choice) => choice.needsReview);
    const index = unresolved.findIndex((choice) => choice.key === activeKey);
    const next = unresolved[(index + 1) % unresolved.length];
    if (next) revealChoice(next);
  });
  modeBar.append(jumpMissing);
  const bulkTools = document.createElement('details');
  bulkTools.className = 'ocr-bulk-tools';
  bulkTools.open = !phoneQuery.matches;
  bulkTools.append(text('summary', '批次選取欄位'), tools);
  const positionBulk = () => {
    if (phoneQuery.matches) afterField.after(bulkTools);
    else modeBar.after(bulkTools);
  };
  positionBulk();
  phoneQuery.addEventListener('change', positionBulk);
  const footer = text('div', '', 'ocr-review-footer');
  const confirmation = document.createElement('label'),
    confirmed = document.createElement('input');
  confirmed.type = 'checkbox';
  confirmation.className = 'ocr-confirmation';
  confirmation.append(
    confirmed,
    document.createTextNode(' 我已確認截圖屬於 ' + host.dataset.domain + '、' + targetLabel + '，以及各欄標示的全裝置／桌面限定範圍。'),
  );
  const actionLine = text('div', '', 'ocr-review-actions');
  const apply = text('button', '填入勾選欄位', 'primary');
  apply.type = 'button';
  apply.disabled = true;
  const applyStatus = text('span', '先勾選確認，再填入表單；尚未儲存。', 'note');
  applyStatus.id = 'ocr-apply-status';
  apply.setAttribute('aria-describedby', applyStatus.id);
  applyStatus.setAttribute('role', 'status');
  actionLine.append(apply, applyStatus);
  const localError = text('p', '', 'ocr-apply-error');
  localError.setAttribute('role', 'alert');
  localError.tabIndex = -1;
  localError.hidden = true;
  const refresh = text('button', '更新目前內容，保留核對修正');
  refresh.type = 'button';
  refresh.hidden = true;
  refresh.addEventListener('click', () => {
    const latest = current();
    for (const choice of choices) {
      if (latest[choice.key] !== choice.before) {
        choice.before = latest[choice.key];
        choice.check.checked = false;
        choice.previous.textContent = latest[choice.key] ? '目前：' + latest[choice.key] + choice.unit : '';
        choice.status.textContent = '表單已變更，預設保留；確認覆寫才勾選';
      }
    }
    localError.hidden = true;
    refresh.hidden = true;
    apply.hidden = false;
    confirmed.checked = false;
    stale = false;
    setStatus('比較內容已更新，核對修正保留；請重新確認後填入。');
    confirmed.focus();
    updateSelection();
  });
  const shortcut = text('div', '', 'ocr-review-shortcut');
  const shortcutCount = text('span');
  const shortcutButton = text('button', '前往填入確認 ↓');
  shortcutButton.type = 'button';
  shortcutButton.addEventListener('click', () => {
    confirmed.focus();
    confirmed.scrollIntoView({ block: 'center' });
  });
  const jumpConfirm = text('button', '前往填入確認 ↓');
  jumpConfirm.type = 'button';
  jumpConfirm.addEventListener('click', () => shortcutButton.click());
  navigation.append(jumpConfirm);
  const returnButton = text('button', '回到表單欄位 ↓');
  returnButton.type = 'button';
  returnButton.hidden = true;
  returnButton.addEventListener('click', () => {
    returnToForm?.focus();
    returnToForm?.closest('.field').scrollIntoView({ block: 'center' });
  });
  navigation.append(returnButton);
  for (const [label, offset] of [
    ['上一欄', -1],
    ['下一欄', 1],
  ]) {
    const step = text('button', label);
    step.type = 'button';
    step.addEventListener('click', () => {
      advanceField(offset);
    });
    stepButtons.push([step, offset]);
    modeBar.append(step);
  }
  shortcut.append(shortcutCount, shortcutButton);
  review.append(shortcut);
  footer.append(confirmation, localError, refresh, actionLine);
  function fail(message, choice, invalid = true) {
    localError.textContent =
      choice && !invalid
        ? '尚未填入。請查看「' + screenshotFields[choice.key] + '」旁的衝突說明。'
        : choice && invalid
          ? '尚未填入。請修正「' + screenshotFields[choice.key] + '」欄位。'
          : message;
    localError.hidden = false;
    if (choice) {
      if (invalid) choice.input.setAttribute('aria-invalid', 'true');
      choice.status.textContent = message;
      choice.row.classList.add('has-error');
      revealChoice(choice);
      if (!invalid) choice.check.focus({ preventScroll: true });
    } else localError.focus();
  }
  review.append(footer);
  function updateSelection() {
    localError.hidden = true;
    for (const choice of choices) {
      choice.input.removeAttribute('aria-invalid');
      choice.row.classList.remove('has-error');
    }
    for (const choice of choices) choice.updateCountry?.();
    const selected = choices.filter((c) => c.check.checked);
    const unresolved = choices.filter((choice) => choice.needsReview);
    if (countryNotice)
      countryNotice.textContent = unresolved.some((c) => c.key === 'taiwan')
        ? '台灣占比未讀到，請對照國家表補正。'
        : unresolved.some((c) => c.key === 'countries')
          ? '國家列表尚待補正，請對照原圖補齊。'
          : '國家辨識疑點已處理，仍請對照原圖核對數字。';
    count.textContent = choices.length + ' 欄 · 數值疑點 ' + unresolved.length;
    shortcutCount.textContent = '已選 ' + selected.length + ' 欄' + (unresolved.length ? ' · 數值疑點 ' + unresolved.length : '');
    jumpMissing.hidden = !unresolved.length;
    jumpMissing.textContent = '需補正 ' + unresolved.length + ' 項 →';
    selectionCount.textContent = '已選 ' + selected.length + ' / ' + choices.length;
    for (const choice of choices) {
      const same = Boolean(choice.before) && sameValue(choice.key, choice.value, choice.before);
      choice.row.classList.toggle('is-identical', same);
      choice.row.classList.toggle('is-overwrite', Boolean(choice.before) && !same && choice.check.checked);
      if (!applied && !choice.needsReview && !choice.row.classList.contains('has-error')) {
        if (same) choice.status.textContent = '與目前相同，無需覆寫';
        else if (choice.before)
          choice.status.textContent = choice.check.checked
            ? '將覆寫：' + choice.before + choice.unit + ' → ' + choice.value + choice.unit
            : '與目前不同，保留原值；勾選才覆寫';
      }
      choice.row.classList.toggle('is-selected', choice.check.checked);
      choice.row.classList.toggle('is-missing', choice.needsReview);
    }
    apply.disabled = applied || stale || !confirmed.checked || !selected.length;
    if (!applied)
      applyStatus.textContent = stale
        ? '請先更新目前內容，再確認要覆寫的欄位。'
        : !selected.length
          ? '請先勾選至少一個要填入的欄位。'
          : !confirmed.checked
            ? '請勾選上方確認：網站、月份與裝置範圍。'
            : selected.length +
              ' 個欄位將填入 ' +
              targetLabel +
              (selected.some((c) => c.before) ? '，覆寫 ' + selected.filter((c) => c.before).length + ' 欄' : '') +
              ' · 尚未儲存';
  }
  confirmed.addEventListener('change', updateSelection);
  apply.addEventListener('click', () => {
    const selected = choices.filter((c) => c.check.checked);
    localError.hidden = true;
    if (selected.some((c) => !c.value)) {
      fail(
        '勾選的欄位仍是空白，請先填入數值或取消勾選。',
        selected.find((choice) => !choice.value),
      );
      return;
    }
    for (const choice of selected) {
      choice.input.removeAttribute('aria-invalid');
      const { key, value } = choice;
      let message = '';
      if (!['visits', 'pages', 'duration', 'countries'].includes(key) && (!/^\d+(?:\.\d+)?$/.test(value) || Number(value) > 100))
        message = '請填 0–100 之間的百分比。';
      if (key === 'visits' && (!/^\d+(?:\.\d+)?[KMB]?$/i.test(value.replace(/,/g, '')) || !(parseFloat(value) > 0)))
        message = '請填大於 0 的造訪量，例如 482.4K。';
      if (key === 'pages' && (!/^\d+(?:\.\d+)?$/.test(value) || !(Number(value) > 0))) message = '每次造訪頁數請填大於 0 的數字。';
      if (key === 'duration' && !/^(?:\d+(?:\.\d+)?|\d+:[0-5]\d(?::[0-5]\d)?)$/.test(value)) message = '請填秒數、分:秒或時:分:秒。';
      if (message) {
        choice.input.setAttribute('aria-invalid', 'true');
        choice.status.textContent = message;
        fail(screenshotFields[key] + '：' + message, choice);
        return;
      }
    }
    const latest = current();
    if (selected.some((c) => latest[c.key] !== c.before)) {
      fail('核對期間表單內容已變更。請更新目前內容；核對修正會保留，變更的欄位將取消勾選。');
      stale = true;
      refresh.hidden = false;
      refresh.classList.add('primary');
      apply.hidden = true;
      apply.disabled = true;
      return;
    }
    const nextValues = { ...latest, ...Object.fromEntries(selected.map((c) => [c.key, c.value])) };
    for (const [scope, keys] of [
      ['桌面限定', Object.keys(screenshotFields).filter((key) => key.startsWith('desktop_'))],
      [
        '全裝置',
        Object.keys(screenshotFields).filter(
          (key) => !key.startsWith('desktop_') && !['visits', 'pages', 'duration', 'bounce', 'taiwan', 'countries'].includes(key),
        ),
      ],
    ]) {
      const total = keys.reduce((sum, key) => sum + Number((nextValues[key] || '0').replace(/%$/, '')), 0);
      if (total > 100.1) {
        const kept = choices.filter(
          (choice) =>
            keys.includes(choice.key) &&
            !choice.check.checked &&
            choice.before &&
            choice.value &&
            Number(choice.before) !== Number(choice.value),
        );
        const description = kept.length
          ? '保留的' +
            kept.map((choice) => screenshotFields[choice.key] + ' ' + choice.before + '%（截圖 ' + choice.value + '%）').join('、') +
            '與新值合併後超標。請勾選要改用的截圖值，或調整表單。'
          : '請核對這一組的所有占比。';
        fail(
          scope + '流量來源合計 ' + total.toFixed(2) + '%，超過 100%。' + description,
          kept[0] || selected.find((choice) => keys.includes(choice.key)),
          false,
        );
        return;
      }
    }
    const countryChoice = selected.find((c) => c.key === 'countries');
    const taiwanChoice = selected.find((c) => c.key === 'taiwan');
    const lines = (nextValues.countries || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const shares = lines.map((line) => /^([A-Z]{2})\s+(\d+(?:\.\d+)?)%?$/i.exec(line));
    if (
      shares.some((row) => !row || Number(row[2]) > 100) ||
      new Set(shares.filter(Boolean).map((row) => row[1].toUpperCase())).size !== shares.length
    ) {
      fail('國家占比請每行填不重複的國家代碼與 0–100 百分比，例如 TW 93.23。', countryChoice);
      if (countryChoice) {
        countryChoice.input.setAttribute('aria-invalid', 'true');
        countryChoice.input.focus();
      }
      return;
    }
    const listedTw = shares.find((row) => row[1].toUpperCase() === 'TW');
    if (nextValues.taiwan && listedTw && Math.abs(Number(nextValues.taiwan) - Number(listedTw[2])) > 0.000001) {
      const keptTaiwan = choices.find((choice) => choice.key === 'taiwan' && !choice.check.checked);
      fail(
        '台灣占比 ' + nextValues.taiwan + '% 與國家列表 TW ' + listedTw[2] + '% 不一致。請確認要保留或改用的數值。',
        keptTaiwan || taiwanChoice || countryChoice,
        false,
      );
      return;
    }
    const total = shares.reduce((sum, row) => sum + Number(row[2]), 0) + (!listedTw && nextValues.taiwan ? Number(nextValues.taiwan) : 0);
    if (total > 100.1) {
      fail('國家占比合計超過 100%，請核對後再填入。', countryChoice || taiwanChoice);
      return;
    }
    if (countryChoice?.needsReview) {
      fail('國家列表仍有漏辨識，請補齊；若只填部分國家，需確認列表旁的缺漏與合計占比。', countryChoice, false);
      countryAcknowledgement?.focus();
      return;
    }
    if (taiwanChoice && countryChoice && !listedTw) {
      countryChoice.value = 'TW ' + taiwanChoice.value + (lines.length ? '\n' + lines.join('\n') : '');
      countryChoice.input.value = countryChoice.value;
    }
    if (month.value !== targetMonth) {
      month.value = targetMonth;
      month.dispatchEvent(new Event('change', { bubbles: true }));
    }
    for (const { key, value } of selected) {
      const field = form.elements.namedItem(key);
      field.value = value;
      field.dataset.ocrFilled = 'true';
      const source = [...new Set((result.sources?.[key] || []).map((s) => '截圖 ' + (s.image + 1)))].join('、');
      const back = text('button', (source || '手動補正') + ' · 回到原圖核對 ↖', 'ocr-form-source');
      back.type = 'button';
      back.addEventListener('click', () => {
        returnToForm = field;
        returnButton.hidden = false;
        returnButton.textContent = '回到表單・' + screenshotFields[key] + ' ↓';
        revealChoice(choices.find((choice) => choice.key === key));
      });
      field.closest('.field').append(back);
    }
    if (selected.some(({ key }) => key.startsWith('desktop_'))) form.querySelector('[data-desktop-channels]').open = true;
    form.dispatchEvent(new Event('input', { bubbles: true }));
    applied = true;
    right.classList.add('is-applied');
    right.querySelector('.ocr-results-hint').textContent = '已填入表單；此處保留核對結果。需要修改時，請回到表單。';
    reviewDirty = false;
    updateSaveHandoff(false);
    updateTarget();
    shortcut.hidden = true;
    bulkTools.hidden = true;
    for (const button of tools.querySelectorAll('button')) button.disabled = true;
    for (const choice of choices) {
      choice.check.disabled = true;
      choice.input.readOnly = true;
      choice.status.textContent = choice.check.checked ? '已填入表單 · 尚未儲存' : '未填入';
      choice.previous.textContent = choice.before ? '填入前：' + choice.before + choice.unit : '';
      if (choice.key === 'countries' && countryAcknowledgement) countryAcknowledgement.closest('label').hidden = true;
    }
    confirmation.hidden = true;
    apply.hidden = true;
    const next = text('button', '前往表單儲存 ↓', 'primary');
    next.type = 'button';
    next.addEventListener('click', () => {
      const target = returnToForm || form.elements.namedItem('visits');
      target.focus({ preventScroll: true });
      target.closest('.field').scrollIntoView({ block: 'center' });
    });
    actionLine.prepend(next);
    next.focus({ preventScroll: true });
    applyStatus.textContent = '已填入 ' + selected.length + ' 個欄位，尚未儲存；原圖與核對結果保留在上方。';
    progress.textContent = applyStatus.textContent;
    setStep('save');
    updateSelection();
  });
  const startReview = text('button', '開始核對 ↓', 'primary ocr-start-review');
  startReview.type = 'button';
  startReview.addEventListener('click', () => revealChoice(choices.find((choice) => choice.needsReview) || choices[0]));
  heading.append(startReview);
  renderImage();
  selectField(choices.find((choice) => choice.needsReview)?.key || choices[0].key);
  updateSelection();
  setStep('review');
  recognize.textContent = '重新辨識';
  recognize.classList.remove('primary');
  heading.focus({ preventScroll: true });
  heading.scrollIntoView({ block: 'start' });
}
recognize.addEventListener('click', async () => {
  if (busy) return;
  if (review.childElementCount) {
    changeFiles(
      images.map((image) => image.file),
      recognize,
    );
    return;
  }
  const files = images.map((image) => image.file);
  if (!files.length || files.length > 4) {
    progress.textContent = '請選擇 1–4 張同一網站、同一月份的截圖。';
    return;
  }
  clearFormSources();
  busy = true;
  setStep('recognize');
  setStatus('正在準備辨識工具…');
  host.setAttribute('aria-busy', 'true');
  recognize.disabled = true;
  fileInput.disabled = true;
  renderFiles();
  review.replaceChildren();
  let worker, cancelRun;
  let cancelled = false;
  const cancellation = new Promise((_, reject) => {
    cancelRun = reject;
  });
  const cancel = text('button', '取消辨識');
  cancel.type = 'button';
  progress.after(cancel);
  cancel.className = 'ocr-cancel';
  progress.tabIndex = -1;
  progress.focus({ preventScroll: true });
  cancel.addEventListener('click', () => {
    cancelled = true;
    cancelRun(Error('已取消辨識。截圖與表單保留，可重新嘗試。'));
  });
  try {
    await Promise.race([
      cancellation,
      (async () => {
        progress.textContent = '正在準備辨識工具，首次使用需下載辨識資料，請稍候…';
        await loadEngine();
        if (cancelled) return;
        const created = await createOcrWorker();
        if (cancelled) {
          await created.terminate().catch(() => {});
          return;
        }
        worker = created;
        await worker.setParameters({ tessedit_pageseg_mode: '11' });
        const results = [];
        for (let i = 0; i < files.length; i++) {
          if (cancelled) return;
          progress.textContent = '正在辨識第 ' + (i + 1) + '／' + files.length + ' 張截圖…';
          const canvas = await imageCanvas(files[i]);
          try {
            const tsv = await recognizeCanvas(canvas, worker, '11');
            const result = await reviewScreenshotCountries(tsv, parseScreenshot(tsv, true), async () => {
              progress.textContent = '正在複核第 ' + (i + 1) + '／' + files.length + ' 張截圖的國家表…';
              return parseScreenshot(await recognizeCanvas(canvas, worker, '6'), true);
            });
            if (cancelled) return;
            images[i].width = canvas.width;
            images[i].height = canvas.height;
            for (const regions of [
              ...Object.values(result.sources || {}),
              ...Object.values(result.uncertainSources || {}),
              result.countryContexts || [],
            ])
              for (const region of regions) region.image = i;
            result.warnings = result.warnings.map((warning) => '截圖 ' + (i + 1) + '：' + warning);
            results.push(result);
          } finally {
            canvas.width = 0;
            canvas.height = 0;
          }
        }
        if (cancelled) return;
        showReview(mergeScreenshots(results));
        progress.textContent = '辨識完成，請核對下方結果；目前尚未更動表單。';
      })(),
    ]);
  } catch (error) {
    review.replaceChildren();
    setStatus(
      typeof error?.message === 'string' && /^[\u3400-\u9fff]/.test(error.message)
        ? error.message
        : '辨識失敗，請重新嘗試；若瀏覽器不支援辨識，也可使用下方表單手動輸入。',
      true,
    );
  } finally {
    if (worker) await worker.terminate().catch(() => {});
    cancel.remove();
    busy = false;
    host.removeAttribute('aria-busy');
    recognize.disabled = false;
    fileInput.disabled = false;
    renderFiles();
    if (!review.childElementCount) {
      setStep('select');
      recognize.focus();
    }
  }
});
