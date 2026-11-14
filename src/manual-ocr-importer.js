import {
  mergeScreenshots,
  parseScreenshot,
  refineScreenshotCountryLabels,
  refineScreenshotNumbers,
  reviewScreenshotCountries,
  screenshotFields,
  screenshotSelectableCountryCodes,
} from './parser.js';

const host = document.getElementById('manual-import');
const fileInput = host.querySelector('input[type=file]');
const recognize = host.querySelector('[data-recognize]');
const progress = host.querySelector('[data-progress]');
const form = document.querySelector('.manual-form');
const month = form.elements.namedItem('month');
const text = (tag, value, className = '') => {
  const node = document.createElement(tag);
  node.textContent = value;
  node.className = className;
  return node;
};
const describe = (control, ...ids) =>
  control.setAttribute(
    'aria-describedby',
    [...new Set([control.getAttribute('aria-describedby'), ...ids].filter(Boolean).join(' ').split(/\s+/))].join(' '),
  );
function createCountryHelper(getTarget, onSelect = () => {}, prefix = '') {
  const countryHelper = document.createElement('details');
  countryHelper.className = 'ocr-country-helper';
  countryHelper.addEventListener('focusin', (event) => {
    if (event.target.tagName !== 'SUMMARY') onSelect();
  });
  countryHelper.addEventListener('toggle', () => {
    if (countryHelper.open) onSelect();
  });
  countryHelper.append(text('summary', '用國家名稱新增或更新占比'));
  const countrySearch = document.createElement('input');
  countrySearch.type = 'search';
  countrySearch.setAttribute('aria-label', prefix + '搜尋國家名稱或代碼');
  countrySearch.placeholder = '搜尋台灣、Taiwan 或 TW';
  const picker = document.createElement('select');
  picker.setAttribute('aria-label', prefix + '選擇國家名稱');
  const localNames = new Intl.DisplayNames(['zh-Hant'], { type: 'region' });
  const englishNames = new Intl.DisplayNames(['en'], { type: 'region' });
  const countryOptions = [];
  for (const code of screenshotSelectableCountryCodes) countryOptions.push({ code, name: localNames.of(code) });
  const chooseCountry = text('option', '選擇國家名稱');
  chooseCountry.value = '';
  picker.append(chooseCountry);
  for (const { code, name } of countryOptions.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))) {
    const option = text('option', name + ' · ' + englishNames.of(code) + ' (' + code + ')');
    option.value = code;
    picker.append(option);
  }
  picker.value = '';
  const share = document.createElement('input');
  share.setAttribute('aria-label', prefix + '新增國家占比');
  share.inputMode = 'decimal';
  share.placeholder = '占比 %';
  const insert = text('button', prefix ? '加入或更新表單國家' : '加入或更新國家');
  insert.type = 'button';
  const helperStatus = text('p', '選擇國家名稱即可，不必記國家代碼。');
  helperStatus.setAttribute('role', 'status');
  countrySearch.addEventListener('input', () => {
    const query = countrySearch.value.trim().toLocaleLowerCase();
    const matches = countryOptions.filter(({ code, name }) =>
      (code + ' ' + name + ' ' + englishNames.of(code)).toLocaleLowerCase().includes(query),
    );
    picker.replaceChildren(chooseCountry);
    for (const { code, name } of matches) {
      const option = text('option', name + ' · ' + englishNames.of(code) + ' (' + code + ')');
      option.value = code;
      picker.append(option);
    }
    picker.value = matches.length === 1 ? matches[0].code : '';
    helperStatus.textContent = '找到 ' + matches.length + ' 個國家；請核對名稱再輸入占比。';
  });
  insert.addEventListener('click', () => {
    const target = getTarget();
    const value = share.value.trim().replace(/%$/, '');
    if (!picker.value) {
      helperStatus.textContent = '請先選擇國家名稱。';
      picker.focus();
      return;
    }
    if (!/^\d+(?:\.\d+)?$/.test(value) || Number(value) > 100) {
      helperStatus.textContent = '請填 0–100 的占比。';
      share.focus();
      return;
    }
    const code = picker.value;
    const lines = target.value.split('\n').filter(Boolean);
    const index = lines.findIndex((line) => line.trim().split(/\s+/)[0].toUpperCase() === code);
    if (index >= 0) lines[index] = code + ' ' + value;
    else lines.push(code + ' ' + value);
    lines.sort((a, b) => Number(b.trim().split(/\s+/)[1]) - Number(a.trim().split(/\s+/)[1]));
    target.value = lines.join('\n');
    target.setSelectionRange(target.value.length, target.value.length);
    target.scrollTop = target.scrollHeight;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    helperStatus.textContent =
      '已更新 ' + localNames.of(code) + ' ' + value + '%，請核對列表；' + (target === formCountries ? '尚未儲存。' : '尚未填入表單。');
  });
  for (const [label, control] of [
    ['搜尋國家', countrySearch],
    ['國家名稱', picker],
    ['占比（%）', share],
  ]) {
    const field = text('label', '', 'ocr-helper-field');
    field.append(text('span', label), control);
    countryHelper.append(field);
  }
  countryHelper.append(insert, helperStatus);
  countryHelper.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || event.target.tagName !== 'INPUT') return;
    event.preventDefault();
    if (event.target === countrySearch) (picker.value ? share : picker).focus();
    else if (event.target === share) insert.click();
  });

  return {
    element: countryHelper,
    search: countrySearch,
    share,
    reset: () => {
      countrySearch.value = '';
      countrySearch.dispatchEvent(new Event('input'));
      share.value = '';
      helperStatus.textContent = '選擇國家名稱即可，不必記國家代碼。';
      countryHelper.open = false;
    },
  };
}
const countryDisplayNames = new Intl.DisplayNames(['zh-Hant'], { type: 'region' });
function valueError(key, value) {
  if (!value) return '';
  if (key === 'countries') {
    const rows = value
      .split('\n')
      .filter(Boolean)
      .map((line) => /^([A-Z]{2})\s+(\d+(?:\.\d+)?)%?$/i.exec(line.trim()));
    return rows.some((row) => !row || Number(row[2]) > 100 || !screenshotSelectableCountryCodes.includes(row[1].toUpperCase())) ||
      new Set(rows.filter(Boolean).map((row) => row[1].toUpperCase())).size !== rows.length
      ? '國家占比請填不重複的國家與 0–100 百分比。'
      : rows.reduce((sum, row) => sum + Number(row[2]), 0) > 100.1
        ? '國家占比合計超過 100%，請對照原圖修正。'
        : '';
  }
  if (key === 'visits')
    return /^\d+(?:\.\d+)?[KMB]?$/i.test(value.replace(/,/g, '')) && parseFloat(value) > 0 ? '' : '請填大於 0 的造訪量，例如 482.4K。';
  if (key === 'pages') return /^\d+(?:\.\d+)?$/.test(value) && Number(value) > 0 ? '' : '每次造訪頁數請填大於 0 的數字。';
  if (key === 'duration') return /^(?:\d+(?:\.\d+)?|\d+:[0-5]\d(?::[0-5]\d)?)$/.test(value) ? '' : '請填秒數、分:秒或時:分:秒。';
  return /^\d+(?:\.\d+)?$/.test(value) && Number(value) <= 100 ? '' : '請填 0–100 之間的百分比。';
}
function offerCountryUndo(rows, target, code, original, focus) {
  rows.parentElement.querySelector('.ocr-country-undo')?.remove();
  const notice = text('div', '', 'ocr-country-undo');
  notice.setAttribute('role', 'status');
  notice.append(text('span', '已移除' + countryDisplayNames.of(code) + '。'));
  const undo = text('button', '復原移除' + countryDisplayNames.of(code));
  undo.type = 'button';
  undo.addEventListener('click', () => {
    const lines = target.value.split('\n').filter(Boolean);
    if (!lines.some((line) => line.trim().split(/\s+/)[0].toUpperCase() === code)) lines.push(original);
    lines.sort((a, b) => Number(b.trim().split(/\s+/)[1]) - Number(a.trim().split(/\s+/)[1]));
    target.value = lines.join('\n');
    target.dispatchEvent(new Event('input', { bubbles: true }));
    notice.remove();
    focus();
  });
  notice.append(undo);
  rows.after(notice);
}
const formCountries = form.elements.namedItem('countries');
const formCountryRows = text('div', '', 'ocr-country-rows');
const formCountryRaw = document.createElement('details');
formCountryRaw.className = 'ocr-country-raw';
formCountryRaw.append(text('summary', '進階：編輯國家代碼清單'));
formCountries.before(formCountryRows, formCountryRaw);
formCountryRaw.append(formCountries, formCountries.nextElementSibling);
const formCountryInputs = new Map();
const formTaiwan = form.elements.namedItem('taiwan');
const serverTaiwanValue = formTaiwan.value;
let serverTaiwanInvalid = formTaiwan.getAttribute('aria-invalid') === 'true';
const formCountryWarning = text('p', '', 'ocr-cross-warning');
formCountryWarning.setAttribute('role', 'status');
formCountryWarning.id = 'manual-country-consistency';
formCountryRaw.after(formCountryWarning);
const formTaiwanWarning = text('p', '', 'ocr-cross-warning');
formTaiwanWarning.id = 'manual-taiwan-consistency';
formTaiwan.closest('.input-unit').after(formTaiwanWarning);
describe(formTaiwan, formTaiwanWarning.id);
let previousListedTw = /^TW\s+(\S+)/m.exec(formCountries.value)?.[1] || '';
function renderFormCountries(event) {
  // Taiwan has one visible editor. Keep its country-list representation in step
  // only when the user edits that value; restoring or recognising drafts never
  // silently resolves a disagreement between existing sources.
  if (event?.target === formTaiwan && /^TW(?:\s|$)/m.test(formCountries.value)) {
    formCountries.value = formCountries.value
      .split('\n')
      .flatMap((row) => {
        if (!/^TW(?:\s|$)/i.test(row)) return [row];
        return formTaiwan.value.trim() ? ['TW ' + formTaiwan.value.trim()] : [];
      })
      .join('\n');
  }
  const currentTw = /^TW\s+(\S+)/m.exec(formCountries.value)?.[1] || '';
  if (event?.target === formCountries && currentTw !== previousListedTw) formTaiwan.value = currentTw;
  previousListedTw = currentTw;
  const names = new Intl.DisplayNames(['zh-Hant'], { type: 'region' });
  const listedTw = /^TW\s+(\d+(?:\.\d+)?)$/m.exec(formCountries.value);
  const mismatch = formTaiwan.value && listedTw && Number(formTaiwan.value) !== Number(listedTw[1]);
  const basicError = valueError('taiwan', formTaiwan.value);
  const countryError = valueError('countries', formCountries.value);
  if (formTaiwan.value !== serverTaiwanValue) serverTaiwanInvalid = false;
  formCountryWarning.hidden = !mismatch && !countryError.includes('合計');
  formCountryWarning.textContent = mismatch
    ? '台灣占比 ' + formTaiwan.value + '% 與國家列表的台灣 ' + listedTw[1] + '% 不一致，請先修正再儲存。'
    : countryError;
  formTaiwan.setCustomValidity(basicError || (mismatch || countryError.includes('合計') ? formCountryWarning.textContent : ''));
  formTaiwan.setAttribute('aria-invalid', String(Boolean(mismatch || basicError || serverTaiwanInvalid)));
  formTaiwanWarning.hidden = !mismatch && !basicError;
  formTaiwanWarning.textContent = basicError || (mismatch ? formCountryWarning.textContent : '');
  const codes = new Set();
  let rawRequired = false;
  for (const line of formCountries.value.split('\n').filter(Boolean)) {
    const [code, share = ''] = line.trim().toUpperCase().split(/\s+/);
    if (!screenshotSelectableCountryCodes.includes(code) || codes.has(code)) {
      rawRequired = true;
      continue;
    }
    codes.add(code);
    if (code === 'TW') {
      if (!/^\d+(?:\.\d+)?$/.test(share) || Number(share) > 100) rawRequired = true;
      continue;
    }
    let entry = formCountryInputs.get(code);
    if (!entry) {
      const label = text('div', '', 'ocr-country-row');
      const editor = document.createElement('input');
      editor.inputMode = 'decimal';
      editor.id = 'manual-country-' + code;
      editor.dataset.country = code;
      editor.setAttribute('aria-label', '表單國家列表・' + names.of(code) + '占比');
      const wrap = text('span', '', 'ocr-country-share');
      wrap.append(editor, text('span', '%'));
      label.append(text('span', names.of(code)), wrap);
      const remove = text('button', '×', 'ocr-remove-country');
      remove.type = 'button';
      remove.setAttribute('aria-label', '移除表單國家列表中的' + names.of(code));
      label.append(remove);
      const error = text('small', '', 'ocr-country-entry-error');
      error.id = 'form-country-error-' + code;
      error.setAttribute('role', 'status');
      editor.setAttribute('aria-describedby', error.id);
      label.append(error);
      entry = { label, input: editor, error };
      formCountryInputs.set(code, entry);
      remove.addEventListener('click', () => {
        const original = formCountries.value.split('\n').find((row) => row.trim().split(/\s+/)[0].toUpperCase() === code);
        const position = [...formCountryRows.children].indexOf(label);
        formCountries.value = formCountries.value
          .split('\n')
          .filter((row) => row.trim().split(/\s+/)[0].toUpperCase() !== code)
          .join('\n');
        formCountries.dispatchEvent(new Event('input', { bubbles: true }));
        const inputs = [...formCountryRows.querySelectorAll('input')];
        const next = inputs[Math.min(position, inputs.length - 1)] || form.querySelector('[data-country-add]');
        next.focus();
        offerCountryUndo(formCountryRows, formCountries, code, original, () => formCountryInputs.get(code)?.input.focus());
      });
      editor.addEventListener('input', () => {
        formCountries.value = formCountries.value
          .split('\n')
          .map((row) => (row.trim().split(/\s+/)[0].toUpperCase() === code ? code + ' ' + editor.value.trim().replace(/%$/, '') : row))
          .join('\n');
        formCountries.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    if (document.activeElement !== entry.input) entry.input.value = share;
    const valid = /^\d+(?:\.\d+)?$/.test(share) && Number(share) <= 100;
    const totalError = countryError.includes('合計') ? countryError : '';
    entry.input.setAttribute('aria-invalid', String(!valid || Boolean(totalError)));
    entry.input.setCustomValidity(valid ? totalError : names.of(code) + '占比請填 0–100 的數字，或移除此國家。');
    entry.error.hidden = valid;
    entry.error.textContent = valid ? '' : '請填 0–100 的數字，或移除此國家。';
    const position = codes.size - 1;
    if (formCountryRows.children[position] !== entry.label)
      formCountryRows.insertBefore(entry.label, formCountryRows.children[position] || null);
  }
  for (const [code, entry] of formCountryInputs)
    if (!codes.has(code)) {
      entry.label.remove();
      formCountryInputs.delete(code);
    }
  formCountries.setCustomValidity(rawRequired ? countryError : '');
  if (rawRequired) {
    formCountryRaw.open = true;
    formCountryWarning.hidden = false;
  }
  form.querySelector('label[for^="manual-countr"]')?.setAttribute('for', formCountryRows.querySelector('input')?.id || 'manual-countries');
}
form.addEventListener('input', renderFormCountries, true);
form.addEventListener('change', renderFormCountries);
form.addEventListener('manual:values-changed', renderFormCountries);
formCountryRows.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || event.target.tagName !== 'INPUT') return;
  event.preventDefault();
  const inputs = [...formCountryRows.querySelectorAll('input')];
  const next = inputs[inputs.indexOf(event.target) + 1];
  if (next) next.focus();
  else {
    openCountryDialog('add');
  }
});
renderFormCountries();
const formCountryTools = createCountryHelper(
  () => formCountries,
  () => {},
  '表單',
);
const formCountryHelper = formCountryTools.element;
formCountryHelper.classList.add('ocr-form-country-helper');
const countryDialog = document.createElement('dialog');
countryDialog.className = 'ocr-country-dialog';
countryDialog.setAttribute('aria-labelledby', 'manual-country-dialog-title');
const countryDialogHeading = text('div', '', 'ocr-country-dialog-heading');
const countryDialogTitle = text('h3', '編輯國家分布');
countryDialogTitle.id = 'manual-country-dialog-title';
const closeCountryDialog = text('button', '完成');
closeCountryDialog.type = 'button';
closeCountryDialog.addEventListener('click', () => countryDialog.close());
countryDialogHeading.append(countryDialogTitle, closeCountryDialog);
countryDialog.append(countryDialogHeading, formCountryHelper, formCountryRaw);
form.append(countryDialog);
function openCountryDialog(mode) {
  formCountryHelper.open = mode === 'add';
  formCountryRaw.open = mode === 'code';
  if (!countryDialog.open) countryDialog.showModal();
  (mode === 'add' ? formCountryTools.search : formCountries).focus();
}
for (const [selector, mode] of [
  ['[data-country-add]', 'add'],
  ['[data-country-code]', 'code'],
]) {
  const button = form.querySelector(selector);
  button.hidden = false;
  button.addEventListener('click', () => openCountryDialog(mode));
}
// Native validation must reveal a malformed raw list before focusing it.
formCountries.addEventListener('invalid', () => openCountryDialog('code'));
const base = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
let busy = false;
let images = [];
let selectedImage = 0;
let zoom = 1;
let lastResult = null;
let resultMonth = '';
const autoValues = new Map();
const sourceView = host.querySelector('[data-source-view]');
const sourceImage = host.querySelector('[data-source-image]');
const sheet = sourceImage.parentElement;
const marker = sheet.querySelector('.ocr-source-marker');
const saveHint = form.querySelector('.manual-save-bar span');
const defaultSaveHint = saveHint.textContent;
let formValidationMessage = '';
const formValueChecks = Object.keys(screenshotFields)
  .filter((key) => !['countries', 'taiwan'].includes(key))
  .map((key) => {
    const control = form.elements.namedItem(key);
    const error = text('p', '', 'ocr-form-value-error');
    error.id = 'manual-value-error-' + key;
    error.setAttribute('role', 'status');
    error.hidden = true;
    (control.closest('.input-unit') || control).after(error);
    describe(control, error.id);
    return { key, control, error, serverInvalid: control.getAttribute('aria-invalid') === 'true', serverValue: control.value };
  });
function validateFormValues(event) {
  const errors = new Map(formValueChecks.map(({ key, control }) => [key, valueError(key, control.value.trim())]));
  for (const desktop of [false, true]) {
    const entries = formValueChecks.filter(
      ({ key }) => key.startsWith('desktop_') === desktop && !['visits', 'pages', 'duration', 'bounce'].includes(key),
    );
    const total = entries.reduce((sum, { control }) => sum + Number(control.value || 0), 0);
    if (entries.some(({ control }) => control.value))
      form.querySelector(desktop ? '[data-desktop-channels]' : '[data-all-channels]').open = true;
    if (!entries.some(({ key }) => errors.get(key)) && total > 100.1) {
      const target = entries.find(({ control }) => control === event?.target) || entries.find(({ control }) => control.value);
      errors.set(target.key, (desktop ? '桌面限定' : '全裝置') + '流量來源合計 ' + total.toFixed(2) + '%，超過 100%，請核對這一組占比。');
    }
  }
  for (const entry of formValueChecks) {
    const { key, control, error } = entry;
    if (control.value !== entry.serverValue) entry.serverInvalid = false;
    const message = errors.get(key);
    control.setCustomValidity(message);
    control.setAttribute('aria-invalid', String(Boolean(message || entry.serverInvalid)));
    error.hidden = !message;
    error.textContent = message;
  }
  const first = formValueChecks.find(({ key }) => errors.get(key));
  formValidationMessage = first
    ? '請先修正「' + screenshotFields[first.key] + '」旁的提示，再儲存此月份。'
    : formTaiwanWarning.textContent
      ? '請先修正台灣占比旁的提示，再儲存此月份。'
      : '';
  saveHint.textContent = formValidationMessage || defaultSaveHint;
}
form.addEventListener('input', validateFormValues);
form.addEventListener('change', validateFormValues);
form.addEventListener('manual:values-changed', validateFormValues);
validateFormValues();
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
    let preparationPercent = 0;
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
        const stages = ['loading tesseract core', 'initializing tesseract', 'loading language traineddata', 'initializing api'];
        preparationPercent = Math.max(preparationPercent, Math.round((stages.indexOf(event.status) + (event.progress || 0)) * 25));
        progress.textContent = '正在準備辨識工具 ' + preparationPercent + '%，請稍候…';
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
  const readCrop = async ({ x, y, w, h }, scale = 2, paddingRatio = 0.4) => {
    const padding = h * paddingRatio;
    const left = Math.max(0, x - padding),
      top = Math.max(0, y - padding);
    const width = Math.min(canvas.width - left, w + padding * 2),
      height = Math.min(canvas.height - top, h + padding * 2);
    const crop = document.createElement('canvas');
    crop.width = Math.round(width * scale);
    crop.height = Math.round(height * scale);
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
  };
  await worker.setParameters({ tessedit_pageseg_mode: mode, tessedit_char_whitelist: '' });
  try {
    const { data } = await worker.recognize(canvas, {}, { text: true, tsv: true });
    await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789.%<>≤≥' });
    const refined = await refineScreenshotNumbers(data.tsv || '', readCrop);
    await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '' });
    return await refineScreenshotCountryLabels(refined, (region) => readCrop(region, 3, 0.3));
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

function setStatus(message, error = false) {
  progress.textContent = message;
  progress.classList.toggle('is-error', error);
}
function sizeSourceImage() {
  if (!sourceImage.naturalWidth || !sourceImage.naturalHeight) return;
  const fit = Math.min(
    (sourceView.clientWidth - 12) / sourceImage.naturalWidth,
    (sourceView.clientHeight - 12) / sourceImage.naturalHeight,
  );
  sheet.style.width = Math.max(1, Math.floor(sourceImage.naturalWidth * fit * zoom)) + 'px';
}
function setZoom(next) {
  zoom = Math.max(1, Math.min(6, next));
  sizeSourceImage();
  host.querySelector('[data-zoom-reset]').textContent = zoom === 1 ? '完整圖片' : Math.round(zoom * 100) + '%';
}
sourceImage.addEventListener('load', sizeSourceImage);
new ResizeObserver(sizeSourceImage).observe(sourceView);
host.querySelector('[data-zoom-in]').addEventListener('click', () => setZoom(zoom + 0.5));
host.querySelector('[data-zoom-out]').addEventListener('click', () => setZoom(zoom - 0.5));
host.querySelector('[data-zoom-reset]').addEventListener('click', () => setZoom(1));
function showImage(index, reset = true) {
  if (!images[index]) return;
  selectedImage = index;
  const image = images[index];
  sourceImage.src = image.url;
  sourceImage.alt = '截圖 ' + (index + 1) + '：' + image.file.name;
  sheet.hidden = false;
  sourceView.querySelector('.ocr-empty').hidden = true;
  host.querySelector('[data-zoom]').hidden = false;
  marker.hidden = true;
  if (reset) {
    setZoom(1);
    sourceView.scrollTo(0, 0);
  }
  for (const button of host.querySelectorAll('[data-image]'))
    button.setAttribute('aria-pressed', String(Number(button.dataset.image) === index));
}
async function showSource(key, region) {
  if (resultMonth !== month.value || !lastResult) return;
  const regions =
    lastResult.sources?.[key] || lastResult.uncertainSources?.[key] || (key === 'countries' ? lastResult.countryContexts : []) || [];
  const source = region || regions.find((entry) => entry.image === selectedImage) || regions[0];
  if (!source || !images[source.image]) return;
  showImage(source.image, false);
  try {
    await sourceImage.decode();
  } catch {
    return;
  }
  if (images[selectedImage]?.url !== sourceImage.src) return;
  const image = images[selectedImage];
  const box = source.valueBox || source;
  marker.style.left = Math.max(0, (box.x / image.width) * 100 - 0.5) + '%';
  marker.style.top = Math.max(0, (box.y / image.height) * 100 - 0.3) + '%';
  marker.style.width = Math.min(100, (box.w / image.width) * 100 + 1) + '%';
  marker.style.height = Math.min(100, (box.h / image.height) * 100 + 0.6) + '%';
  marker.hidden = false;
  sourceView.scrollTo({
    top: marker.offsetTop - sourceView.clientHeight * 0.4,
    left: marker.offsetLeft - sourceView.clientWidth * 0.4,
    behavior: 'smooth',
  });
}
function renderFiles() {
  const list = host.querySelector('[data-files]');
  list.replaceChildren();
  for (const [index, image] of images.entries()) {
    const item = text('div', '', 'ocr-file');
    const choose = text('button', index + 1 + ' · ' + image.file.name);
    choose.type = 'button';
    choose.dataset.image = index;
    choose.title = image.file.name;
    choose.setAttribute('aria-pressed', String(index === selectedImage));
    choose.addEventListener('click', () => showImage(index));
    const remove = text('button', '×');
    remove.type = 'button';
    remove.disabled = busy;
    remove.setAttribute('aria-label', '移除截圖 ' + (index + 1) + '：' + image.file.name);
    remove.addEventListener('click', () => {
      images = images.filter((entry) => entry !== image);
      URL.revokeObjectURL(image.url);
      selectedImage = 0;
      lastResult = null;
      for (const note of form.querySelectorAll('.ocr-reading-note')) note.remove();
      for (const control of form.querySelectorAll('[data-ocr-filled]')) delete control.dataset.ocrFilled;
      renderFiles();
      if (images.length) {
        showImage(0);
        runRecognition();
      } else {
        sheet.hidden = true;
        sourceView.querySelector('.ocr-empty').hidden = false;
        host.querySelector('[data-zoom]').hidden = true;
        setStatus('截圖已移除，表單內容保留。');
      }
    });
    item.append(choose, remove);
    list.append(item);
  }
  recognize.hidden = !images.length;
  recognize.disabled = busy;
  fileInput.disabled = busy;
  host.setAttribute('aria-busy', String(busy));
  for (const button of form.querySelectorAll('[type=submit]')) button.disabled = busy;
}
function selectFiles(files) {
  if (busy) return;
  const notes = [];
  for (const file of files) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
      notes.push('「' + file.name + '」請使用 10 MB 以內的 PNG、JPG 或 WebP。');
      continue;
    }
    if (
      images.some(
        (entry) => entry.file.name === file.name && entry.file.size === file.size && entry.file.lastModified === file.lastModified,
      )
    ) {
      notes.push('已略過重複截圖「' + file.name + '」。');
      continue;
    }
    if (images.length >= 4) {
      notes.push('最多加入 4 張截圖。');
      continue;
    }
    images.push({ file, url: URL.createObjectURL(file) });
  }
  fileInput.value = '';
  renderFiles();
  if (images.length) {
    showImage(selectedImage);
    host.closest('.manual-columns').scrollIntoView({ block: 'start', behavior: 'smooth' });
    runRecognition(notes);
  } else setStatus(notes.join(' '), true);
}
fileInput.addEventListener('change', () => selectFiles([...fileInput.files]));
const dropzone = host.querySelector('[data-dropzone]');
for (const event of ['dragenter', 'dragover'])
  host.addEventListener(event, (e) => {
    e.preventDefault();
    if (!busy) dropzone.classList.add('is-dragging');
  });
for (const event of ['dragleave', 'drop'])
  host.addEventListener(event, (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-dragging');
  });
host.addEventListener('drop', (e) => {
  if (e.dataTransfer.files.length) selectFiles([...e.dataTransfer.files]);
});

function showWarnings(result) {
  host.querySelector('.ocr-recognition-notes')?.remove();
  if (!result.warnings.length) return;
  const details = document.createElement('details');
  details.className = 'ocr-help ocr-recognition-notes';
  details.append(text('summary', '辨識備註 · 請核對截圖範圍'));
  const list = document.createElement('ul');
  for (const warning of result.warnings) list.append(text('li', warning));
  details.append(list);
  host.querySelector('.ocr-source-status').after(details);
}
function readingNote(key, message, candidates = []) {
  const control = form.elements.namedItem(key);
  if (!control) return;
  const note = text('div', '', 'ocr-reading-note');
  note.append(text('span', message));
  for (const { value, source } of candidates) {
    const use = text('button', '採用 ' + value.replace(/\n/g, ' · '));
    use.type = 'button';
    use.addEventListener('click', () => {
      control.value = value;
      control.dispatchEvent(new Event('input', { bubbles: true }));
      control.dataset.ocrFilled = 'true';
      autoValues.set(key, value);
      note.remove();
      showSource(key, source);
    });
    note.append(use);
  }
  note.dataset.readingKey = key;
  const anchor = key === 'countries' ? formCountryRows : control.closest('.input-unit') || control;
  anchor.after(note);
}
function applyReadings(result, startedMonth, startingValues, changedDuringRun) {
  if (month.value !== startedMonth) throw Error('辨識期間月份已變更，表單保留。請在目標月份按「重新辨識」。');
  if (result.months.length > 1) throw Error('截圖包含不同月份，請只保留同一月份的截圖；表單尚未變更。');
  const target = result.months[0] || startedMonth;
  if (![...month.options].some((option) => option.value === target)) throw Error('截圖月份超出可補登範圍，表單尚未變更。');
  if (target !== startedMonth) {
    // Draft script saves the outgoing month and restores the target month.
    month.value = target;
    month.dispatchEvent(new Event('change', { bubbles: true }));
    startingValues = Object.fromEntries(Object.keys(screenshotFields).map((key) => [key, form.elements.namedItem(key).value]));
    changedDuringRun = new Set();
  }
  for (const note of form.querySelectorAll('.ocr-reading-note')) note.remove();
  lastResult = result;
  resultMonth = target;
  showWarnings(result);
  let filled = 0,
    kept = 0;
  const keys = new Set([...Object.keys(result.fields), ...Object.keys(result.uncertainSources || {}), ...autoValues.keys()]);
  for (const key of keys) {
    const control = form.elements.namedItem(key);
    if (!control) continue;
    const reading = result.fields[key];
    const canReplace =
      !changedDuringRun.has(key) &&
      (startingValues[key] === '' || (autoValues.has(key) && sameValue(key, startingValues[key], autoValues.get(key))));
    delete control.dataset.ocrFilled;
    if (reading !== undefined && !valueError(key, reading)) {
      if (canReplace || sameValue(key, control.value, reading)) {
        if (canReplace) control.value = reading;
        if (!changedDuringRun.has(key) && canReplace) {
          autoValues.set(key, control.value);
          control.dataset.ocrFilled = 'true';
        }
        filled++;
      } else {
        kept++;
        readingNote(key, '保留你原有的內容；截圖讀到不同數值。', [{ value: reading }]);
      }
    } else {
      if (canReplace && autoValues.has(key)) control.value = '';
      autoValues.delete(key);
      if (result.uncertainSources?.[key]?.length) {
        const values = new Set();
        const candidates = result.uncertainSources[key]
          .filter((entry) => {
            if (key === 'countries' || values.has(entry.value) || valueError(key, entry.value)) return false;
            values.add(entry.value);
            return true;
          })
          .map((source) => ({ value: source.value, source }));
        readingNote(
          key,
          candidates.length > 1 ? '截圖讀到不同數值，請對照原圖選擇或直接修改。' : '這一欄無法可靠辨識，請對照原圖補上。',
          candidates,
        );
      }
    }
  }
  if (result.countryTable) {
    if (result.fields.taiwan === undefined && !result.uncertainSources?.taiwan?.length)
      readingNote('taiwan', '這張圖的台灣占比尚未可靠辨識，請對照原圖補上。');
    const count = result.fields.countries?.split('\n').filter(Boolean).length || 0;
    if (count < result.countryExpectedCount || result.unmatchedCountries?.length) {
      readingNote('countries', '只填入可靠讀到的國家；原圖還有未辨識的列，請對照左側補上。');
    }
  }
  form.dispatchEvent(new Event('input', { bubbles: true }));
  for (const selector of ['[data-all-channels]', '[data-desktop-channels]']) {
    const group = form.querySelector(selector);
    group.open = [...group.querySelectorAll('input[name]')].some((input) => input.value);
  }
  setStatus(
    (target !== startedMonth ? '已切換至 ' + target.slice(0, 4) + '/' + target.slice(4) + '。' : '') +
      '已從截圖填入 ' +
      filled +
      ' 欄' +
      (kept ? '，保留 ' + kept + ' 欄原有內容' : '') +
      '，請對照後儲存。',
  );
}
form.addEventListener('focusin', (event) => {
  const key = event.target.name || (event.target.closest('.ocr-country-row') ? 'countries' : '');
  if (key)
    showSource(
      key,
      event.target.dataset.country
        ? lastResult?.sources?.countries?.find((source) => source.value.startsWith(event.target.dataset.country + ' '))
        : undefined,
    );
});
form.addEventListener('input', (event) => {
  const key = event.target.name;
  if (key && autoValues.has(key) && !sameValue(key, event.target.value, autoValues.get(key))) {
    autoValues.delete(key);
    delete event.target.dataset.ocrFilled;
  }
});
form.addEventListener('manual:values-changed', () => {
  autoValues.clear();
  for (const control of form.querySelectorAll('[data-ocr-filled]')) delete control.dataset.ocrFilled;
  for (const note of form.querySelectorAll('.ocr-reading-note')) note.remove();
  marker.hidden = true;
});
// Numeric editing must never implicitly save the page.
form.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.tagName === 'INPUT' && !event.isComposing && event.keyCode !== 229) event.preventDefault();
});
form.addEventListener(
  'submit',
  (event) => {
    if (busy) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  },
  true,
);
recognize.addEventListener('click', () => runRecognition());
async function runRecognition(uploadNotes = []) {
  if (busy || !images.length) return;
  busy = true;
  const startedMonth = month.value;
  const startingValues = Object.fromEntries(Object.keys(screenshotFields).map((key) => [key, form.elements.namedItem(key).value]));
  const changedDuringRun = new Set();
  const rememberEdit = (event) => {
    if (event.target.name) changedDuringRun.add(event.target.name);
  };
  form.addEventListener('input', rememberEdit);
  const files = images.map((image) => image.file);
  renderFiles();
  setStatus('正在準備辨識工具…');
  let worker, rejectCancel;
  let cancelled = false;
  const cancellation = new Promise((_, reject) => {
    rejectCancel = reject;
  });
  const cancel = text('button', '取消');
  cancel.type = 'button';
  cancel.className = 'ocr-cancel';
  progress.after(cancel);
  cancel.addEventListener('click', () => {
    cancelled = true;
    rejectCancel(Error('已取消，表單內容保留。可按「重新辨識」重試。'));
  });
  try {
    await Promise.race([
      cancellation,
      (async () => {
        await loadEngine();
        if (cancelled) return;
        const created = await createOcrWorker();
        if (cancelled) {
          await created.terminate().catch(() => {});
          return;
        }
        worker = created;
        const results = [];
        for (let i = 0; i < files.length; i++) {
          if (cancelled) return;
          setStatus('正在辨識截圖 ' + (i + 1) + ' / ' + files.length + '…');
          const canvas = await imageCanvas(files[i]);
          try {
            const tsv = await recognizeCanvas(canvas, worker, '11');
            const result = await reviewScreenshotCountries(tsv, parseScreenshot(tsv, true), async () =>
              parseScreenshot(await recognizeCanvas(canvas, worker, '6'), true),
            );
            if (cancelled) return;
            images[i].width = canvas.width;
            images[i].height = canvas.height;
            for (const regions of [
              ...Object.values(result.sources || {}),
              ...Object.values(result.uncertainSources || {}),
              result.countryContexts || [],
            ])
              for (const region of regions) region.image = i;
            for (const country of result.unmatchedCountries || []) country.image = i;
            results.push(result);
          } finally {
            canvas.width = 0;
            canvas.height = 0;
          }
        }
        if (!cancelled) {
          applyReadings(mergeScreenshots(results), startedMonth, startingValues, changedDuringRun);
          if (uploadNotes.length) setStatus(progress.textContent + ' ' + uploadNotes.join(' '));
        }
      })(),
    ]);
  } catch (error) {
    setStatus(
      typeof error?.message === 'string' && /^[\u3400-\u9fff]/.test(error.message)
        ? error.message
        : '辨識失敗，表單內容保留。可重新辨識或直接手動填寫。',
      true,
    );
  } finally {
    if (worker) await worker.terminate().catch(() => {});
    form.removeEventListener('input', rememberEdit);
    cancel.remove();
    busy = false;
    renderFiles();
  }
}
renderFiles();
