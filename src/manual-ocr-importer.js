import { mergeScreenshots, parseScreenshot, refineScreenshotNumbers, reviewScreenshotCountries, screenshotFields } from './parser.js';

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
function setStep(step) {
  for (const item of host.querySelectorAll('[data-step]')) {
    if (item.dataset.step === step) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
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
let pendingFiles = null;
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
    remove.addEventListener('click', () => changeFiles(images.filter((entry) => entry !== image).map((entry) => entry.file)));
    item.append(thumbnail, info, remove);
    list.append(item);
  }
  recognize.disabled = busy || !images.length;
}
function commitFiles(files) {
  clearFormSources();
  const previous = images;
  images = files.map((file) => previous.find((entry) => entry.file === file) || { file, url: URL.createObjectURL(file) });
  for (const entry of previous) if (!images.includes(entry)) URL.revokeObjectURL(entry.url);
  review.replaceChildren();
  fileDecision.hidden = true;
  pendingFiles = null;
  fileInput.value = '';
  renderFiles();
  progress.textContent = images.length ? '已選 ' + images.length + ' 張截圖，可繼續加入；按「辨識截圖」開始。' : '請選擇截圖。';
  setStep('select');
}
function changeFiles(files) {
  if (busy) return;
  if (files.length > 4) {
    progress.textContent = '最多 4 張截圖；目前已選 ' + images.length + ' 張，請先移除再加入。';
    return;
  }
  for (const file of files) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
      progress.textContent = '「' + file.name + '」無法加入：請選 PNG、JPG 或 WebP，每張最多 10 MB。';
      return;
    }
  }
  if (review.childElementCount) {
    pendingFiles = files;
    fileDecision.replaceChildren(text('p', '更改截圖需要重新辨識，會清除這次核對的修正。已填入的表單會保留。'));
    const accept = text('button', '更改截圖並重新核對');
    const cancel = text('button', '保留目前核對');
    accept.type = cancel.type = 'button';
    accept.addEventListener('click', () => commitFiles(pendingFiles));
    cancel.addEventListener('click', () => {
      pendingFiles = null;
      fileDecision.hidden = true;
      fileInput.value = '';
    });
    fileDecision.append(accept, cancel);
    fileDecision.hidden = false;
    cancel.focus();
  } else commitFiles(files);
}
function selectFiles() {
  const additions = [...fileInput.files].filter(
    (file) => !images.some((entry) => entry.file.name === file.name && entry.file.size === file.size),
  );
  changeFiles([...images.map((entry) => entry.file), ...additions]);
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
  changeFiles([...images.map((entry) => entry.file), ...e.dataTransfer.files]);
});
renderFiles();
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
function showReview(result) {
  review.replaceChildren();
  if (result.months.length > 1) throw Error('截圖包含不同月份，請只選同一個月份的截圖。');
  const targetMonth = result.months[0] || month.value;
  if (![...month.options].some((o) => o.value === targetMonth)) throw Error('截圖月份超出可補登範圍，請確認日期。');
  const entries = Object.entries(result.fields).filter(([key]) => screenshotFields[key]);
  if (!entries.length && !result.countryTable)
    throw Error('沒有辨識到可補登的數值，請改用清楚的英文版概況、國家或流量來源截圖，也可直接手填。');
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
  const targetLabel = targetMonth.slice(0, 4) + '/' + targetMonth.slice(4);
  const heading = text('div', '', 'ocr-review-heading');
  const title = text('div');
  title.append(text('h3', '核對辨識結果'), text('p', host.dataset.domain + ' · ' + targetLabel, 'ocr-target'));
  heading.append(title, text('span', images.length + ' 張截圖 · ' + Object.keys(result.fields).length + ' 個欄位', 'ocr-count'));
  review.append(heading);
  const warnings = [...result.warnings];
  if (!result.months.length) warnings.push('未讀到月份，目前使用表單月份 ' + targetLabel + '，請確認。');
  if (missingTaiwan) warnings.unshift('台灣占比未讀到，請對照原圖手動補上；不會用其他國家的剩餘占比推算。');
  if (warnings.length) {
    const notice = document.createElement('details');
    notice.className = 'ocr-notices';
    notice.open = true;
    notice.append(text('summary', '有 ' + warnings.length + ' 項範圍或辨識提示，請核對'));
    for (const warning of warnings) notice.append(text('p', warning));
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
  viewport.setAttribute('aria-label', '原圖檢視區，可捲動查看');
  const stage = text('div', '', 'ocr-image-stage');
  const original = new Image();
  original.draggable = false;
  const overlay = text('div', '', 'ocr-overlay');
  stage.append(original, overlay);
  viewport.append(stage);
  const focusLabel = text('p', '點選右側欄位，查看對應截圖與橘色標記。', 'ocr-focus-label');
  viewer.append(viewerHead, tabs, caption, controls, viewport, focusLabel);
  workspace.append(viewer);
  const right = text('section', '', 'ocr-results');
  right.setAttribute('aria-label', '辨識欄位與填入位置');
  const resultHead = text('div', '', 'ocr-panel-head');
  const selectionCount = text('span', '', 'ocr-selection-count');
  resultHead.append(text('h4', '辨識值 → 表單欄位'), selectionCount);
  right.append(resultHead, text('p', '勾選要填入的欄位；可直接修正數值。已有內容預設保留。', 'ocr-results-hint'));
  workspace.append(right);
  const navigation = text('nav', '', 'ocr-section-nav');
  navigation.setAttribute('aria-label', '核對欄位分類');
  review.append(navigation, workspace);
  const current = () => {
    const detail = { month: targetMonth, values: null };
    form.dispatchEvent(new CustomEvent('manual:read-month', { detail }));
    if (!detail.values) throw Error('表單尚未就緒，請重新整理後再試。');
    return detail.values;
  };
  const before = current(),
    choices = [];
  let activeKey = '',
    activeImage = 0,
    applied = false;
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
  function selectField(key, move = true, imageIndex) {
    activeKey = key;
    const regions = result.sources?.[key] || [];
    if (imageIndex !== undefined) activeImage = imageIndex;
    else if (regions.length) activeImage = regions[0].image;
    for (const choice of choices) {
      choice.row.classList.toggle('is-active', choice.key === key);
      choice.evidence.hidden = choice.key !== key;
    }
    renderEvidence();
    const active = choices.find((choice) => choice.key === key);
    if (active && document.activeElement === active.input && matchMedia('(max-width: 760px)').matches)
      requestAnimationFrame(() => active.row.scrollIntoView({ block: 'nearest' }));
    renderImage();
    if (move)
      requestAnimationFrame(() => {
        const marker = overlay.querySelector('.is-active');
        if (marker) {
          // Scroll only the image pane, keeping the result field in view.
          viewport.scrollTop = Math.max(0, marker.offsetTop - viewport.clientHeight * 0.35);
          viewport.scrollLeft = Math.max(0, marker.offsetLeft - viewport.clientWidth * 0.2);
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
      for (const region of result.sources?.[choice.key] || []) {
        if (region.image !== activeImage) continue;
        // Taiwan and its country-list entry share a box; show one active marker.
        const id = [region.x, region.y, region.w, region.h].join(':');
        if (markers.has(id) && choice.key !== activeKey) continue;
        const marker = text('button', '', 'ocr-marker' + (choice.key === activeKey ? ' is-active' : ''));
        marker.type = 'button';
        marker.setAttribute('aria-label', '查看' + screenshotFields[choice.key] + '：' + region.value);
        marker.title = screenshotFields[choice.key] + ' · ' + region.value;
        marker.style.left = Math.max(0, ((region.x - 8) / image.width) * 100) + '%';
        marker.style.top = Math.max(0, ((region.y - 6) / image.height) * 100) + '%';
        marker.style.width = Math.min(100, ((region.w + 16) / image.width) * 100) + '%';
        marker.style.height = ((region.h + 12) / image.height) * 100 + '%';
        marker.addEventListener('click', () => {
          selectField(choice.key, false, activeImage);
          choice.input.focus({ preventScroll: true });
          choice.row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
        markers.get(id)?.remove();
        markers.set(id, marker);
        overlay.append(marker);
      }
    const label = screenshotFields[activeKey];
    const linked = (result.sources?.[activeKey] || []).some((s) => s.image === activeImage);
    focusLabel.textContent = label
      ? label + (linked ? ' · 橘框為辨識來源，請對照數字。' : ' · 這張截圖沒有可定位的辨識來源。')
      : '點選右側欄位，查看對應截圖與橘色標記。';
  }
  function renderEvidence() {
    const choice = choices.find((entry) => entry.key === activeKey);
    if (!choice) return;
    choice.evidence.replaceChildren();
    const regions = result.sources?.[activeKey] || [];
    if (!regions.length) {
      choice.evidence.append(text('p', '沒有可定位的來源。請在上方原圖核對後手動補正。'));
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
      choice.evidence.append(text('span', '截圖 ' + (index + 1) + ' · 原圖局部（保留原始像素）'), canvas);
    }
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
    navigation.append(jump);
    section.append(text('h4', label + (label === '桌面限定流量來源' ? ' · Desktop Only' : '')));
    right.append(section);
    for (const [key, value] of fields) {
      const row = text('div', '', 'ocr-field-row');
      row.dataset.field = key;
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = Boolean(value) && !before[key];
      check.setAttribute('aria-label', '填入' + screenshotFields[key]);
      const content = text('div', '', 'ocr-field-content');
      const sourceButton = text('button', screenshotFields[key], 'ocr-field-label');
      sourceButton.type = 'button';
      sourceButton.setAttribute('aria-label', '定位' + screenshotFields[key]);
      const imageIndexes = [...new Set((result.sources?.[key] || []).map((s) => s.image))];
      const sourceLinks = text('div', '', 'ocr-field-sources');
      for (const index of imageIndexes) {
        const link = text('button', '截圖 ' + (index + 1) + ' ↖', 'ocr-source-link');
        link.type = 'button';
        link.setAttribute('aria-label', screenshotFields[key] + '的截圖 ' + (index + 1));
        link.addEventListener('click', () => selectField(key, true, index));
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
      if (!value) input.placeholder = '未讀到，請手動填寫';
      const unit = !['visits', 'pages', 'duration', 'countries'].includes(key) ? '%' : key === 'pages' ? '頁' : '';
      const inputWrap = text('div', '', 'ocr-edit-value');
      inputWrap.append(input);
      if (unit) inputWrap.append(text('span', unit, 'ocr-unit'));
      const previous = text('span', before[key] ? '目前：' + before[key] + (unit ? unit : '') : '目前空白', 'ocr-previous');
      editorLine.append(inputWrap, previous);
      const status = text(
        'span',
        before[key] ? '已有內容，預設保留' : value ? '辨識值，可修正' : '未讀到，不會自動填入',
        'ocr-field-status',
      );
      status.id = 'ocr-status-' + key;
      input.setAttribute('aria-describedby', status.id);
      const evidence = text('div', '', 'ocr-inline-evidence');
      evidence.hidden = true;
      content.append(line, evidence, editorLine, status);
      row.append(check, content);
      section.append(row);
      const choice = { key, value, check, before: before[key], row, input, status, sourceButton, evidence, previous };
      choices.push(choice);
      sourceButton.addEventListener('click', () => selectField(key));
      input.addEventListener('focus', () => selectField(key));
      input.addEventListener('input', () => {
        input.removeAttribute('aria-invalid');
        choice.value = input.value.trim();
        if (!choice.before) check.checked = Boolean(choice.value);
        status.textContent =
          choice.before && !check.checked
            ? '修正已保留；勾選左側才會覆寫目前內容'
            : choice.value === value
              ? '辨識值，可修正'
              : '已手動修正 · 請對照原圖';
        updateSelection();
      });
      check.addEventListener('change', () => {
        status.textContent =
          check.checked && choice.before ? '將覆寫目前內容：' + choice.before : choice.before ? '保留目前內容' : '辨識值，可修正';
        updateSelection();
      });
    }
  }
  const tools = text('div', '', 'ocr-selection-tools');
  for (const [label, predicate] of [
    ['勾選空白欄位', (choice) => Boolean(choice.value) && !choice.before],
    ['全部取消', () => false],
  ]) {
    const button = text('button', label);
    button.type = 'button';
    button.addEventListener('click', () => {
      for (const choice of choices) choice.check.checked = predicate(choice);
      updateSelection();
    });
    tools.append(button);
  }
  const missing = choices.filter((choice) => !choice.value);
  if (missing.length) {
    const jumpMissing = text('button', '需補正 ' + missing.length + ' 項 →');
    jumpMissing.type = 'button';
    jumpMissing.addEventListener('click', () => missing.find((choice) => !choice.value)?.input.focus());
    tools.append(jumpMissing);
  }
  right.querySelector('.ocr-results-hint').after(tools);
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
        choice.previous.textContent = latest[choice.key] ? '目前：' + latest[choice.key] : '目前空白';
        choice.status.textContent = '表單已變更，預設保留；確認覆寫才勾選';
      }
    }
    localError.hidden = true;
    refresh.hidden = true;
    confirmed.checked = false;
    updateSelection();
  });
  footer.append(confirmation, localError, refresh, actionLine);
  function fail(message, choice) {
    progress.textContent = message;
    localError.textContent = message;
    localError.hidden = false;
    if (choice) {
      choice.input.setAttribute('aria-invalid', 'true');
      choice.status.textContent = message;
      choice.input.focus();
    } else localError.focus();
  }
  review.append(footer);
  function updateSelection() {
    const selected = choices.filter((c) => c.check.checked);
    selectionCount.textContent = '已選 ' + selected.length + ' / ' + choices.length;
    for (const choice of choices) choice.row.classList.toggle('is-selected', choice.check.checked);
    apply.disabled = applied || !confirmed.checked || !selected.length;
    if (!applied)
      applyStatus.textContent = !selected.length
        ? '請先勾選至少一個要填入的欄位。'
        : !confirmed.checked
          ? '請勾選上方確認：網站、月份與裝置範圍。'
          : selected.length + ' 個欄位將填入 ' + targetLabel + ' · 尚未儲存';
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
        message = '請填 0–100 之間的百分比，不含 % 符號。';
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
      refresh.hidden = false;
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
        fail(
          scope + '流量來源占比合計超過 100%，請核對後再填入。',
          selected.find((choice) => keys.includes(choice.key)),
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
      fail('台灣占比與國家列表的 TW 不一致，請同時修正；已有內容也會保留比較。', taiwanChoice || countryChoice);
      return;
    }
    const total = shares.reduce((sum, row) => sum + Number(row[2]), 0) + (!listedTw && nextValues.taiwan ? Number(nextValues.taiwan) : 0);
    if (total > 100.1) {
      fail('國家占比合計超過 100%，請核對後再填入。', countryChoice || taiwanChoice);
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
        selectField(key);
        right.scrollTop = choices.find((choice) => choice.key === key).row.offsetTop - 12;
        review.querySelector('.ocr-section-nav').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      field.closest('.field').append(back);
    }
    if (selected.some(({ key }) => key.startsWith('desktop_'))) form.querySelector('[data-desktop-channels]').open = true;
    form.dispatchEvent(new Event('input', { bubbles: true }));
    applied = true;
    for (const button of tools.querySelectorAll('button')) button.disabled = true;
    for (const choice of choices) {
      choice.check.disabled = true;
      choice.input.readOnly = true;
      choice.status.textContent = choice.check.checked ? '已填入表單 · 尚未儲存' : '未填入';
    }
    confirmation.hidden = true;
    apply.hidden = true;
    const next = text('button', '前往表單儲存 ↓', 'primary');
    next.type = 'button';
    next.addEventListener('click', () => {
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
      form.elements.namedItem('visits').focus({ preventScroll: true });
    });
    actionLine.prepend(next);
    applyStatus.textContent = '已填入 ' + selected.length + ' 個欄位，尚未儲存；原圖與核對結果保留在上方。';
    progress.textContent = applyStatus.textContent;
    setStep('save');
    updateSelection();
  });
  renderImage();
  selectField(missingTaiwan ? 'taiwan' : choices[0].key);
  updateSelection();
  setStep('review');
}
recognize.addEventListener('click', async () => {
  if (busy) return;
  if (review.childElementCount) {
    changeFiles(images.map((image) => image.file));
    return;
  }
  const files = images.map((image) => image.file);
  if (!files.length || files.length > 4) {
    progress.textContent = '請選擇 1–4 張同一網站、同一月份的截圖。';
    return;
  }
  clearFormSources();
  busy = true;
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
  recognize.after(cancel);
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
            for (const regions of Object.values(result.sources || {})) for (const region of regions) region.image = i;
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
    progress.textContent =
      typeof error?.message === 'string' && /^[\u3400-\u9fff]/.test(error.message)
        ? error.message
        : '辨識失敗，請重新嘗試；若瀏覽器不支援辨識，也可使用下方表單手動輸入。';
  } finally {
    if (worker) await worker.terminate().catch(() => {});
    cancel.remove();
    busy = false;
    host.removeAttribute('aria-busy');
    recognize.disabled = false;
    fileInput.disabled = false;
    renderFiles();
  }
});
