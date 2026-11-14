import {
  mergeScreenshots,
  parseScreenshot,
  refineScreenshotNumbers,
  reviewScreenshotCountries,
  screenshotCountryCodes,
  screenshotFields,
  screenshotSelectableCountryCodes,
} from './parser.js';

const host = document.getElementById('manual-import');
const fileInput = host.querySelector('input[type=file]');
const recognize = host.querySelector('[data-recognize]');
const progress = host.querySelector('[data-progress]');
const review = host.querySelector('[data-review]');
const form = document.querySelector('.manual-form');
const month = form.elements.namedItem('month');
const text = (tag, value, className = '') => {
  const node = document.createElement(tag);
  node.textContent = value;
  node.className = className;
  return node;
};
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
const readableCountries = (value) =>
  value.replace(/\b[A-Z]{2}\b/g, (code) => (screenshotSelectableCountryCodes.includes(code) ? countryDisplayNames.of(code) : code));
const comparisonValue = (key, value) => (key === 'countries' ? readableCountries(value).replaceAll('\n', '、') : value);
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
const formCountryWarning = text('p', '', 'ocr-cross-warning');
formCountryWarning.setAttribute('role', 'status');
formCountryWarning.id = 'manual-country-consistency';
formTaiwan.setAttribute('aria-describedby', 'manual-country-consistency');
formCountryRaw.after(formCountryWarning);
const formTaiwanWarning = text('p', '', 'ocr-cross-warning');
formTaiwanWarning.id = 'manual-taiwan-consistency';
formTaiwan.after(formTaiwanWarning);
formTaiwan.setAttribute('aria-describedby', formTaiwanWarning.id);
function renderFormCountries() {
  const names = new Intl.DisplayNames(['zh-Hant'], { type: 'region' });
  const listedTw = /^TW\s+(\d+(?:\.\d+)?)$/m.exec(formCountries.value);
  const mismatch = formTaiwan.value && listedTw && Number(formTaiwan.value) !== Number(listedTw[1]);
  formCountryWarning.hidden = !mismatch;
  formCountryWarning.textContent = mismatch
    ? '台灣占比 ' + formTaiwan.value + '% 與國家列表的台灣 ' + listedTw[1] + '% 不一致，請先修正再儲存。'
    : '';
  formTaiwan.setCustomValidity(mismatch ? formCountryWarning.textContent : '');
  formTaiwanWarning.hidden = !mismatch;
  formTaiwanWarning.textContent = formCountryWarning.textContent;
  const codes = new Set();
  for (const line of formCountries.value.split('\n').filter(Boolean)) {
    const [code, share = ''] = line.trim().toUpperCase().split(/\s+/);
    if (!screenshotSelectableCountryCodes.includes(code) || codes.has(code)) {
      formCountryRaw.open = true;
      continue;
    }
    codes.add(code);
    let entry = formCountryInputs.get(code);
    if (!entry) {
      const label = text('div', '', 'ocr-country-row');
      const editor = document.createElement('input');
      editor.inputMode = 'decimal';
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
        const next = inputs[Math.min(position, inputs.length - 1)] || formCountryRaw.querySelector('summary');
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
    entry.input.setAttribute('aria-invalid', String(!valid));
    entry.input.setCustomValidity(valid ? '' : names.of(code) + '占比請填 0–100 的數字，或移除此國家。');
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
}
form.addEventListener('input', renderFormCountries);
form.addEventListener('change', renderFormCountries);
form.addEventListener('manual:values-changed', renderFormCountries);
renderFormCountries();
const formCountryTools = createCountryHelper(
  () => formCountries,
  () => {},
  '表單',
);
const formCountryHelper = formCountryTools.element;
formCountryHelper.classList.add('ocr-form-country-helper');
formCountryRaw.after(formCountryHelper);
const base = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
let busy = false;
let images = [];
let reviewDirty = false;
let pendingReview = false;
let reviewMonthChange;
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
  saveHint.textContent = pending ? '先完成上方截圖核對並填入，再儲存此月份。' : defaultSaveHint;
  saveHint.hidden = false;
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
    const message = text('p', '尚未填入核對結果：請先填入，或放棄這次核對。');
    message.setAttribute('role', 'alert');
    const back = text('button', '返回核對並填入', 'primary');
    back.type = 'button';
    back.addEventListener('click', () => {
      saveWarning.hidden = true;
      host.querySelector('.ocr-review-shortcut button').click();
    });
    const discard = text('button', '放棄這次核對，儲存表單目前內容');
    discard.type = 'button';
    discard.addEventListener('click', () => {
      if (!form.reportValidity()) return;
      if (!confirm('放棄尚未填入的截圖修正，並儲存表單目前內容？')) return;
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
// Native validation precedes submit. Pending screenshot review needs its
// own choice before validating the still-empty draft form.
for (const submit of form.querySelectorAll('[type=submit]'))
  submit.addEventListener('click', (event) => {
    if (!pendingReview) return;
    event.preventDefault();
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
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
  formCountryTools.reset();
  for (const field of form.querySelectorAll('[data-ocr-filled]')) {
    delete field.dataset.ocrFilled;
  }
  for (const button of form.querySelectorAll('.ocr-form-source')) button.remove();
  for (const repair of form.querySelectorAll('.ocr-partial-repair, .ocr-country-undo')) repair.remove();
}
form.addEventListener('change', (event) => {
  if (event.target === month) clearFormSources();
});

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
  if (reviewMonthChange) month.removeEventListener('change', reviewMonthChange);
  reviewMonthChange = null;
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
    const rerun = initiator === recognize;
    const accept = text('button', rerun ? '重新辨識並重新核對' : removed.length ? '移除並重新核對' : '更改截圖並重新核對');
    const cancel = text('button', '保留截圖與核對');
    accept.type = cancel.type = 'button';
    accept.addEventListener('click', () => {
      commitFiles(pendingFiles, !rerun);
      if (rerun) recognize.click();
    });
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
  review.classList.remove('is-reviewing');
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
  const primaryOrder = ['visits', 'pages', 'duration', 'bounce', 'taiwan', 'countries'];
  entries.sort(
    ([a], [b]) => (primaryOrder.includes(a) ? primaryOrder.indexOf(a) : 99) - (primaryOrder.includes(b) ? primaryOrder.indexOf(b) : 99),
  );
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
  title.append(text('h3', '核對辨識結果'), text('p', host.dataset.domain + ' · ' + targetLabel, 'ocr-target'));
  const count = text('span', '', 'ocr-count');
  heading.append(title, count);
  review.append(heading);
  let countryNotice;
  const warnings = [...result.warnings];
  if (!result.months.length) warnings.push('未讀到月份，目前使用表單月份 ' + targetLabel + '，請確認。');
  if (missingTaiwan) warnings.unshift('台灣占比未讀到，請對照原圖手動補上；不會用其他國家的剩餘占比推算。');
  if (warnings.length) {
    const notice = document.createElement('details');
    notice.className = 'ocr-notices';
    notice.open = false;
    const scopeImages = [
      ...new Set(
        warnings
          .filter((w) => /未完整辨識出 Worldwide/.test(w))
          .map((w) => /^截圖 (\d+)/.exec(w)?.[1])
          .filter(Boolean),
      ),
    ];
    const summary = text(
      'summary',
      (!result.months.length ? '月份沿用表單，請確認。' : '') +
        (scopeImages.length ? scopeImages.length + ' 張截圖的範圍需人工確認' : '範圍與辨識提示'),
    );
    notice.append(summary);
    if (!result.months.length) notice.append(text('p', '未讀到月份：沿用表單 ' + targetLabel + '，請確認與截圖相符。'));
    if (countryIncomplete) {
      countryNotice = text('span', missingTaiwan ? '・台灣未讀到' : '・國家待補正');
      summary.append(countryNotice);
    }
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
  const right = text('section', '', 'ocr-results');
  right.setAttribute('aria-label', '辨識欄位與填入位置');
  const resultHead = text('div', '', 'ocr-panel-head');
  const selectionCount = text('span', '', 'ocr-selection-count');
  selectionCount.setAttribute('aria-live', 'polite');
  resultHead.append(text('h4', '辨識值 → 表單欄位'), selectionCount);
  right.append(resultHead, text('p', '勾選要填入的欄位；可直接修正數值。已有內容預設保留。', 'ocr-results-hint'));
  workspace.append(right, sourceDisclosure);
  const navigation = text('nav', '', 'ocr-section-nav');
  navigation.setAttribute('aria-label', '核對欄位分類');
  const categorySelect = document.createElement('select');
  categorySelect.className = 'ocr-category-select';
  categorySelect.setAttribute('aria-label', '跳到核對分類');
  categorySelect.addEventListener('change', () =>
    revealChoice(
      choices.find((choice) => choice.key === categorySelect.value),
      false,
    ),
  );
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
    if (phoneQuery.matches) modeBar.append(selectionCount);
    else resultHead.append(selectionCount);
    if (!right.classList.contains('is-applied'))
      right.querySelector('.ocr-results-hint').textContent = phoneQuery.matches
        ? '勾選填入；已有內容預設保留。'
        : '勾選要填入的欄位；可直接修正數值。已有內容預設保留。';
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
  viewer.append(text('p', '欄位旁的原圖局部將欄名與數字分別放大；此處保留原始位置。', 'ocr-crop-explanation'));
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
    if (uncertain.length)
      return uncertain.map((r) => ({
        ...r,
        context:
          '辨識值 ' + r.value + (choices.find((choice) => choice.key === key)?.adoptedImage === r.image ? ' · 已採用此來源' : ' · 待選用'),
      }));
    if (['taiwan', 'countries'].includes(key))
      return (result.countryContexts || []).map((r) => ({ ...r, context: '國家表上下文，非精確辨識位置' }));
    return precise;
  }
  function revealChoice(choice, focusEditor = true) {
    review.classList.add('is-reviewing');
    selectField(choice.key);
    (focusEditor && !applied
      ? choice.countryRows?.querySelector('input[aria-invalid=true]') || choice.countryRows?.querySelector('input') || choice.input
      : choice.row
    ).focus({ preventScroll: true });
    requestAnimationFrame(() => scrollChoice(choice));
  }
  function scrollChoice(choice) {
    if (phoneQuery.matches && choice.countryHelper?.contains(document.activeElement)) {
      document.activeElement.scrollIntoView({ block: 'nearest' });
      return;
    }
    choice.row.scrollIntoView({ block: phoneQuery.matches ? 'start' : 'nearest' });
    if (!phoneQuery.matches) return;
    const editor = choice.countryRows
      ? choice.countryRows.contains(document.activeElement)
        ? document.activeElement
        : choice.countryRows.querySelector('input') || choice.input
      : choice.input;
    const bottom = editor.getBoundingClientRect().bottom;
    const available = window.visualViewport?.height || window.innerHeight;
    // Tall country cards need their evidence and editor together, even when
    // the row's explanatory footer cannot also fit above a phone keyboard.
    if (bottom > available - 12) window.scrollBy(0, bottom - available + 12);
    else if (editor.getBoundingClientRect().top < 12) editor.scrollIntoView({ block: 'center' });
  }
  function selectField(key, move = true, imageIndex) {
    const pointerEditor =
      !phoneQuery.matches &&
      right.contains(document.activeElement) &&
      document.activeElement.matches('input:not([type=checkbox]), textarea')
        ? document.activeElement
        : null;
    const editorTop = pointerEditor?.getBoundingClientRect().top;
    activeKey = key;
    const currentIndex = choices.findIndex((choice) => choice.key === key);
    if (nextAfter)
      nextAfter.textContent = currentIndex === choices.length - 1 ? (applied ? '前往表單儲存 ↓' : '完成逐欄核對 →') : '核對下一欄 →';
    for (const [step, direction] of stepButtons) {
      step.disabled = direction === -1 && currentIndex === 0;
      if (direction === 1) step.textContent = currentIndex === choices.length - 1 ? (applied ? '前往表單' : '前往確認') : '下一欄';
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
    if (pointerEditor) window.scrollBy(0, pointerEditor.getBoundingClientRect().top - editorTop);
    const active = choices.find((choice) => choice.key === key);
    if (!pointerEditor && active?.row.contains(document.activeElement) && document.activeElement !== active.check)
      requestAnimationFrame(() => scrollChoice(active));
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
        marker.style.left = Math.max(0, ((region.x - 16) / image.width) * 100) + '%';
        marker.style.top = Math.max(0, ((region.y - 16) / image.height) * 100) + '%';
        marker.style.width = Math.min(100, ((region.w + 32) / image.width) * 100) + '%';
        marker.style.height = ((region.h + 32) / image.height) * 100 + '%';
        marker.addEventListener('click', () => {
          selectField(choice.key, false, activeImage);
          choice.input.focus({ preventScroll: true });
          scrollChoice(choice);
        });
        markers.get(id)?.remove();
        markers.set(id, marker);
        overlay.append(marker);
      }
    const label = screenshotFields[activeKey];
    const activeRegions = regionsFor(activeKey).filter((s) => s.image === activeImage);
    const linked = activeRegions.length > 0;
    focusLabel.textContent = label
      ? label +
        (linked
          ? activeRegions.some((region) => region.context?.includes('非精確'))
            ? ' · 橘框為國家表上下文，非精確辨識位置。'
            : ' · 橘框為辨識來源，請對照數字。'
          : ' · 這張截圖沒有可定位的辨識來源。')
      : '點選右側欄位，查看對應截圖與橘色標記。';
  }
  function renderEvidence(choice = choices.find((entry) => entry.key === activeKey), target = choice?.evidence) {
    if (!choice) return;
    const signature = choice.key + ':' + applied + ':' + choice.adoptedImage;
    if (target.dataset.signature === signature) return;
    target.dataset.signature = signature;
    target.replaceChildren();
    const regions = regionsFor(choice.key);
    if (!regions.length) {
      target.append(text('p', '沒有精確來源，請查看原圖後補正。'));
      appendFullImageAction(target, choice);
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
      const compact = list.every((region) => region.valueBox);
      canvas.width = compact ? 540 : Math.round(width);
      canvas.height = compact ? list.length * 64 : Math.round(height);
      if (compact) canvas.classList.add('ocr-compact-crop');
      canvas.setAttribute('role', 'img');
      canvas.setAttribute(
        'aria-label',
        '截圖 ' + (index + 1) + ' 原圖局部：' + screenshotFields[choice.key] + '，辨識值 ' + list.map((r) => r.value).join('、'),
      );
      const sourceImage = new Image();
      sourceImage.onload = () => {
        if (compact) {
          const context = canvas.getContext('2d');
          context.fillStyle = '#fff';
          context.fillRect(0, 0, canvas.width, canvas.height);
          const drawBox = (box, x, y, maxWidth) => {
            const scale = Math.min(40 / box.h, maxWidth / box.w);
            context.drawImage(
              sourceImage,
              (box.x / source.width) * sourceImage.naturalWidth,
              (box.y / source.height) * sourceImage.naturalHeight,
              (box.w / source.width) * sourceImage.naturalWidth,
              (box.h / source.height) * sourceImage.naturalHeight,
              x,
              y + (40 - box.h * scale) / 2,
              box.w * scale,
              box.h * scale,
            );
          };
          const labelScale = Math.min(
            ...list.filter((region) => region.labelBox).map((region) => Math.min(40 / region.labelBox.h, 310 / region.labelBox.w)),
          );
          list.forEach((region, row) => {
            if (region.labelBox) {
              const box = region.labelBox;
              context.drawImage(
                sourceImage,
                (box.x / source.width) * sourceImage.naturalWidth,
                (box.y / source.height) * sourceImage.naturalHeight,
                (box.w / source.width) * sourceImage.naturalWidth,
                (box.h / source.height) * sourceImage.naturalHeight,
                12,
                row * 64 + 12 + (40 - box.h * labelScale) / 2,
                box.w * labelScale,
                box.h * labelScale,
              );
            }
            drawBox(region.valueBox, region.labelBox ? 350 : 12, row * 64 + 12, region.labelBox ? 178 : 516);
          });
          return;
        }
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
      if (compact) cropHead.title = '原圖欄名與數值分段放大，已省略欄間空白；完整位置請查看原圖。';
      if (choice.conflict && !applied && choice.key !== 'countries') {
        const adopted = choice.adoptedImage === index;
        const adopt = text(
          'button',
          adopted ? '已採用截圖 ' + (index + 1) : '採用截圖 ' + (index + 1) + ' 的 ' + list[0].value,
          'ocr-adopt-source',
        );
        adopt.type = 'button';
        adopt.setAttribute('aria-pressed', String(adopted));
        adopt.addEventListener('click', () => {
          choice.input.value = list[0].value;
          choice.input.dispatchEvent(new Event('input', { bubbles: true }));
          choice.adoptedImage = index;
          choice.status.textContent = '已採用截圖 ' + (index + 1) + ' 的 ' + list[0].value;
          revealChoice(choice);
        });
        cropHead.append(adopt);
      }
      appendFullImageAction(cropHead, choice, index);
      if (compact) cropHead.classList.add('is-split-crop');
      target.append(cropHead, canvas);
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
        selectField(choice.key);
        (open.isConnected ? open : choice.row).focus({ preventScroll: true });
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
  const keepFocusedFieldVisible = () => {
    if (!review.contains(workspace)) {
      window.removeEventListener('resize', keepFocusedFieldVisible);
      window.visualViewport?.removeEventListener('resize', keepFocusedFieldVisible);
      return;
    }
    const choice = choices.find((entry) => entry.row.contains(document.activeElement));
    if (choice)
      requestAnimationFrame(() => {
        selectField(choice.key);
        scrollChoice(choice);
      });
  };
  window.addEventListener('resize', keepFocusedFieldVisible);
  window.visualViewport?.addEventListener('resize', keepFocusedFieldVisible);

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
      row.tabIndex = -1;
      row.dataset.field = key;
      const check = document.createElement('input');
      check.type = 'checkbox';
      const conflict = result.warnings.some((warning) => warning.includes('不同截圖的' + screenshotFields[key] + '不一致'));
      const needsReview = !value || (key === 'countries' && countryIncomplete);
      check.checked = Boolean(value) && !before[key] && !needsReview;
      check.setAttribute('aria-label', '填入' + screenshotFields[key]);
      const content = text('div', '', 'ocr-field-content');
      const sourceButton = text('button', screenshotFields[key], 'ocr-field-label');
      sourceButton.id = 'ocr-label-' + key;
      row.setAttribute('role', 'group');
      row.setAttribute('aria-labelledby', sourceButton.id);
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
      const previous = text('span', before[key] ? '目前：' + comparisonValue(key, before[key]) + (unit ? unit : '') : '', 'ocr-previous');
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
                ? '兩張截圖的辨識值不一致，請對照原圖局部選用或填寫。'
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
        const countryRows = text('div', '', 'ocr-country-rows');
        const raw = document.createElement('details');
        raw.className = 'ocr-country-raw';
        raw.append(text('summary', '進階：編輯國家代碼清單'), editorLine);
        evidence.after(countryRows, previous, raw);
        choice.countryRows = countryRows;
        const countryNames = new Intl.DisplayNames(['zh-Hant'], { type: 'region' });
        const countryInputs = new Map();
        choice.renderCountryRows = () => {
          const lines = input.value.split('\n').filter(Boolean);
          const oldShares = new Map(
            choice.before
              .split('\n')
              .filter(Boolean)
              .map((line) => line.trim().split(/\s+/)),
          );
          input.rows = Math.max(3, Math.min(10, lines.length));
          const codes = new Set();
          choice.namedError = '';
          for (const line of lines) {
            const [code, share = ''] = line.trim().toUpperCase().split(/\s+/);
            if (!screenshotSelectableCountryCodes.includes(code) || codes.has(code)) continue;
            codes.add(code);
            let entry = countryInputs.get(code);
            if (!entry) {
              const label = text('div', '', 'ocr-country-row');
              const name = text('span', '', 'ocr-country-name');
              const oldValue = text('small', '', 'ocr-country-before');
              name.append(text('span', countryNames.of(code)), oldValue);
              label.append(name);
              const valueWrap = text('span', '', 'ocr-country-share');
              const percentInput = document.createElement('input');
              percentInput.setAttribute('aria-label', '國家列表・' + countryNames.of(code) + '占比');
              percentInput.setAttribute('aria-describedby', status.id);
              percentInput.inputMode = 'decimal';
              percentInput.autocomplete = 'off';
              valueWrap.append(percentInput, text('span', '%'));
              label.append(valueWrap);
              countryRows.append(label);
              const remove = text('button', '×', 'ocr-remove-country');
              remove.type = 'button';
              remove.setAttribute('aria-label', '移除國家列表中的' + countryNames.of(code));
              label.append(remove);
              remove.addEventListener('click', () => {
                const original = input.value.split('\n').find((row) => row.trim().split(/\s+/)[0].toUpperCase() === code);
                const position = [...countryRows.children].indexOf(label);
                input.value = input.value
                  .split('\n')
                  .filter((row) => row.trim().split(/\s+/)[0].toUpperCase() !== code)
                  .join('\n');
                input.dispatchEvent(new Event('input', { bubbles: true }));
                const inputs = [...countryRows.querySelectorAll('input')];
                (inputs[Math.min(position, inputs.length - 1)] || countryHelper.querySelector('summary')).focus();
                offerCountryUndo(countryRows, input, code, original, () => countryInputs.get(code)?.input.focus());
              });
              const error = text('small', '', 'ocr-country-entry-error');
              error.id = 'review-country-error-' + code;
              error.setAttribute('role', 'status');
              percentInput.setAttribute('aria-describedby', error.id);
              label.append(error);
              entry = { label, input: percentInput, remove, error, oldValue };
              countryInputs.set(code, entry);
              percentInput.addEventListener('focus', () => selectField(key));
              percentInput.addEventListener('input', () => {
                const share = percentInput.value.trim().replace(/%$/, '');
                input.value = input.value
                  .split('\n')
                  .map((line) => (line.trim().split(/\s+/)[0].toUpperCase() === code ? code + ' ' + share : line))
                  .join('\n');
                input.dispatchEvent(new Event('input', { bubbles: true }));
              });
            }
            if (document.activeElement !== entry.input) entry.input.value = share.replace(/%$/, '');
            entry.input.readOnly = applied;
            entry.remove.hidden = applied;
            const oldShare = oldShares.get(code);
            const changed = oldShare !== undefined && Number(oldShare) !== Number(share);
            entry.oldValue.hidden = oldShare === undefined;
            entry.oldValue.textContent =
              oldShare === undefined ? '' : (applied ? '填入前 ' : '目前 ') + oldShare + '%' + (changed ? ' → ' + share + '%' : '・相同');
            entry.oldValue.classList.toggle('is-different', changed);
            const valid = /^\d+(?:\.\d+)?%?$/.test(share) && Number(share.replace(/%$/, '')) <= 100;
            entry.input.setAttribute('aria-invalid', String(!valid));
            entry.error.hidden = valid;
            entry.error.textContent = valid ? '' : '請填 0–100 的數字，或移除此國家。';
            if (!valid && !choice.namedError) choice.namedError = countryNames.of(code) + '占比請填 0–100 的數字；不需要此國家時請按移除。';
            const position = codes.size - 1;
            if (countryRows.children[position] !== entry.label)
              countryRows.insertBefore(entry.label, countryRows.children[position] || null);
          }
          for (const [code, entry] of countryInputs) {
            if (!codes.has(code)) {
              entry.label.remove();
              countryInputs.delete(code);
            }
          }
          const removed = [...oldShares].filter(([code]) => !codes.has(code));
          previous.hidden = !removed.length;
          previous.textContent = removed.length
            ? '目前另有：' +
              readableCountries(removed.map(([code, share]) => code + ' ' + share + '%').join('、')) +
              '；覆寫整份列表會移除。'
            : '';
        };
        choice.renderCountryRows();
        const hint = text('small', '每行：TW 93.23（兩碼國家代碼＋百分比）', 'ocr-country-hint');
        hint.id = 'ocr-country-format';
        raw.append(hint);
        input.setAttribute('aria-describedby', status.id + ' ' + hint.id);
        const {
          element: countryHelper,
          search: countrySearch,
          share,
        } = createCountryHelper(
          () => input,
          () => {
            if (!applied) selectField(key);
          },
        );
        content.append(countryHelper);
        choice.countryHelper = countryHelper;
        if (countryIncomplete && result.unmatchedCountries?.length) {
          const unmatched = text('div', '', 'ocr-unmatched-countries');
          unmatched.append(text('p', '以下原圖列的國家名稱未能對應，請選擇國家；占比已保留。'));
          for (const item of result.unmatchedCountries) {
            const repair = text('button', '補上原圖第 ' + item.row + ' 列・' + item.share + '% 的國家');
            repair.type = 'button';
            repair.addEventListener('click', () => {
              if (applied) {
                formCountryHelper.open = true;
                formCountryTools.share.value = item.share;
                formCountryTools.search.focus();
                formCountryTools.search.scrollIntoView({ block: 'center' });
                return;
              }
              countryHelper.open = true;
              share.value = item.share;
              countrySearch.focus();
              countrySearch.scrollIntoView({ block: 'center' });
            });
            unmatched.append(repair);
          }
          choice.unmatched = unmatched;
          countryHelper.before(unmatched);
        }
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
          const expectedCount = Math.max(originalCount + omittedCountries.length, result.countryExpectedCount || 0);
          const unlocatedGap = result.warnings.some((warning) => /國家表.*漏辨識/.test(warning)) && !result.countryExpectedCount;
          choice.updateCountry = () => {
            if (applied) return;
            const lines = choice.value.split('\n').filter(Boolean);
            const codes = lines.map((line) => line.trim().split(/\s+/)[0].toUpperCase());
            const taiwan = choices.find((entry) => entry.key === 'taiwan');
            const addedTaiwan = taiwan?.check.checked && taiwan.value && !codes.includes('TW');
            const missing = expectedCodes.filter((code) => !codes.includes(code) && !(code === 'TW' && addedTaiwan));
            const partial = unlocatedGap || missing.length || lines.length + (addedTaiwan ? 1 : 0) < expectedCount;
            const coverage =
              lines.reduce((sum, line) => sum + (Number(line.trim().split(/\s+/)[1]?.replace(/%$/, '')) || 0), 0) +
              (addedTaiwan ? Number(taiwan.value) || 0 : 0);
            partialLabel.hidden = !partial || applied;
            const omissions = missing.length ? '不含 ' + missing.map((code) => countryDisplayNames.of(code)).join('、') : '可能有未列國家';
            partialText.textContent =
              '我已對照原圖，仍決定只填入這份不完整列表（' + omissions + '；合計 ' + coverage.toFixed(2) + '%）。缺少國家不會自動補上。';
            choice.needsReview = !choice.value || Boolean(partial && !acceptPartial.checked);
            choice.partialAccepted = Boolean(partial && acceptPartial.checked);
            if (choice.unmatched) choice.unmatched.hidden = !partial;
            choice.coverage = coverage;
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
      // Keep the mouse target still until the native click has toggled it.
      // Keyboard focus can update evidence immediately.
      let pointerSelecting = false;
      check.addEventListener('pointerdown', () => {
        pointerSelecting = true;
      });
      check.addEventListener('focus', () => {
        if (!pointerSelecting) selectField(key);
      });
      check.addEventListener('click', () => {
        pointerSelecting = false;
        selectField(key);
      });
      input.addEventListener('input', () => {
        input.removeAttribute('aria-invalid');
        choice.value = input.value.trim();
        choice.renderCountryRows?.();
        if (!['visits', 'duration', 'countries', 'pages'].includes(key)) {
          choice.value = choice.value.replace(/%$/, '').trim();
          input.value = choice.value;
        }
        reviewDirty = true;
        choice.adoptedImage = undefined;
        if (choice.conflict) renderEvidence();
        if (countryAcknowledgement && ['countries', 'taiwan'].includes(key)) countryAcknowledgement.checked = false;
        choice.needsReview = !choice.value;
        if (!choice.before && !choice.selectionTouched) check.checked = Boolean(choice.value);
        status.textContent =
          choice.before && !check.checked
            ? '修正已保留；勾選左側才會覆寫目前內容'
            : choice.value === value
              ? ''
              : choice.value
                ? '已手動修正 · 請對照原圖'
                : '空白，請對照原圖填寫';
        updateSelection();
      });
      check.addEventListener('change', () => {
        choice.selectionTouched = true;
        if (countryAcknowledgement && ['countries', 'taiwan'].includes(key)) countryAcknowledgement.checked = false;
        status.textContent =
          check.checked && choice.before
            ? '將覆寫目前內容：' + choice.before
            : choice.before
              ? '保留目前內容'
              : choice.needsReview
                ? '空白或尚待核對，請對照原圖填寫。'
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
      goToHandoff();
      return;
    }
    revealChoice(choices[Math.max(0, index)], false);
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
      const first = choices.find((choice) => choice.check.checked);
      if (first) revealChoice(first, false);
    });
    tools.append(button);
  }
  const jumpMissing = text('button', '', 'ocr-jump-missing');
  jumpMissing.type = 'button';
  jumpMissing.addEventListener('click', () => {
    const unresolved = choices.filter((choice) => choice.needsReview || choice.error);
    const index = unresolved.findIndex((choice) => choice.key === activeKey);
    const next = unresolved[(index + 1) % unresolved.length];
    if (next) {
      activeKey = next.key;
      if (applied) focusFormField(next.key);
      else revealChoice(next);
    }
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
  const monthNotice = text('p', '', 'ocr-month-notice');
  monthNotice.setAttribute('role', 'status');
  const skipLabel = text('label', '', 'ocr-partial-confirmation');
  const skipAck = document.createElement('input');
  skipAck.type = 'checkbox';
  const skipText = text('span');
  skipLabel.append(skipAck, skipText);
  skipLabel.hidden = true;
  let skipSignature = '';
  const confirmation = document.createElement('label'),
    confirmed = document.createElement('input');
  confirmed.type = 'checkbox';
  confirmation.className = 'ocr-confirmation';
  confirmation.append(
    confirmed,
    document.createTextNode(
      ' 我已確認截圖屬於 ' + host.dataset.domain + '、' + targetLabel + '，以及各欄標示的全裝置／桌面限定範圍。' + '',
    ),
  );
  const actionLine = text('div', '', 'ocr-review-actions');
  const apply = text('button', '填入勾選欄位', 'primary');
  apply.id = 'ocr-apply';
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
  const preflight = text('div', '', 'ocr-preflight');
  preflight.setAttribute('role', 'group');
  preflight.setAttribute('aria-label', '填入前待完成事項');
  const refresh = text('button', '更新目前內容，保留核對修正');
  refresh.type = 'button';
  refresh.hidden = true;
  refresh.addEventListener('click', () => {
    const latest = current();
    for (const choice of choices) {
      if (latest[choice.key] !== choice.before) {
        choice.refreshed = true;
        choice.before = latest[choice.key];
        choice.check.checked = false;
        choice.previous.textContent = latest[choice.key] ? '目前：' + comparisonValue(choice.key, latest[choice.key]) + choice.unit : '';
        choice.status.textContent = '表單已變更，預設保留；確認覆寫才勾選';
        choice.renderCountryRows?.();
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
  function goToHandoff() {
    if (applied) focusFormField(returnToForm?.name || 'visits');
    else {
      confirmed.focus({ preventScroll: true });
      confirmation.scrollIntoView({ block: 'center' });
    }
  }
  function focusFormField(key) {
    const field = form.elements.namedItem(key);
    if (key === 'countries') {
      renderFormCountries();
      const helper = field.closest('.field').querySelector('.ocr-country-helper');
      if (helper) helper.open = true;
      const target = formCountryRows.querySelector('input') || helper?.querySelector('input') || field;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'center' });
      return;
    }
    for (let parent = field.parentElement; parent && parent !== form; parent = parent.parentElement)
      if (parent.tagName === 'DETAILS') parent.open = true;
    field.focus({ preventScroll: true });
    field.closest('.field').scrollIntoView({ block: 'center' });
  }
  shortcutButton.addEventListener('click', goToHandoff);
  const jumpConfirm = text('button', '前往填入確認 ↓');
  jumpConfirm.type = 'button';
  jumpConfirm.addEventListener('click', () => shortcutButton.click());
  navigation.append(jumpConfirm);
  const returnButton = text('button', '回到表單欄位 ↓');
  returnButton.type = 'button';
  returnButton.hidden = true;
  returnButton.addEventListener('click', () => {
    if (returnToForm) focusFormField(returnToForm.name);
  });
  navigation.append(returnButton);
  for (const [label, offset] of [['上一欄', -1]]) {
    const step = text('button', label);
    step.type = 'button';
    step.addEventListener('click', () => {
      advanceField(offset);
    });
    stepButtons.push([step, offset]);
    afterField.prepend(step);
  }
  shortcut.append(shortcutCount, shortcutButton);
  review.append(shortcut);
  footer.append(monthNotice, preflight, confirmation, skipLabel, localError, refresh, actionLine);
  const updateMonthNotice = () => {
    monthNotice.hidden = month.value === targetMonth || applied;
    monthNotice.textContent =
      '將填入 ' +
      targetLabel +
      '；表單目前在 ' +
      month.value.slice(0, 4) +
      '/' +
      month.value.slice(4) +
      '。填入時會切換月份，原月份草稿保留。';
  };
  if (reviewMonthChange) month.removeEventListener('change', reviewMonthChange);
  reviewMonthChange = () => {
    confirmed.checked = false;
    updateMonthNotice();
    updateSelection();
  };
  month.addEventListener('change', reviewMonthChange);
  updateMonthNotice();
  function fail(message, choice, invalid = true) {
    if (choice) {
      const keys = /流量來源合計/.test(message)
        ? choices.filter((entry) => entry.key.startsWith('desktop_') === choice.key.startsWith('desktop_')).map((entry) => entry.key)
        : /國家|台灣占比.*不一致/.test(message)
          ? ['countries', 'taiwan']
          : [choice.key];
      choice.error = { message, invalid, keys, signature: errorSignature(keys) };
      updateSelection();
    }
    applyStatus.textContent = '尚未填入；請先處理待完成事項。';
    localError.textContent =
      choice && !invalid
        ? '尚未填入。請查看「' + screenshotFields[choice.key] + '」旁的待完成說明。'
        : choice && invalid
          ? '尚未填入。請修正「' + screenshotFields[choice.key] + '」欄位。'
          : message;
    localError.hidden = Boolean(choice);
    if (choice) {
      if (invalid) choice.input.setAttribute('aria-invalid', 'true');
      choice.status.textContent = message;
      choice.row.classList.add('has-error');
      revealChoice(choice);
      if (!invalid) choice.check.focus({ preventScroll: true });
    } else localError.focus();
  }
  review.append(footer);
  function errorSignature(keys) {
    return JSON.stringify(
      choices
        .filter((entry) => keys.includes(entry.key))
        .map((entry) => [entry.key, entry.value, entry.check.checked, entry.before, entry.partialAccepted]),
    );
  }
  function updateSelection() {
    localError.hidden = true;
    for (const choice of choices) {
      choice.updateCountry?.();
      if (choice.namedError)
        choice.error = { message: choice.namedError, invalid: true, keys: [choice.key], signature: errorSignature([choice.key]) };
    }
    for (const choice of choices) {
      if (choice.error && choice.error.signature !== errorSignature(choice.error.keys)) choice.error = undefined;
      if (!choice.error) {
        choice.input.removeAttribute('aria-invalid');
        choice.row.classList.remove('has-error');
      }
    }
    const tw = choices.find((choice) => choice.key === 'taiwan');
    const countryList = choices.find((choice) => choice.key === 'countries');
    const listedTw = /^TW\s+(\d+(?:\.\d+)?)$/m.exec(countryList?.value || '');
    const mismatch = !applied && tw?.value && listedTw && Number.isFinite(Number(tw.value)) && Number(tw.value) !== Number(listedTw[1]);
    for (const choice of [tw, countryList].filter(Boolean)) {
      if (!choice.crossWarning) {
        choice.crossWarning = text('p', '', 'ocr-cross-warning');
        choice.crossWarning.setAttribute('role', 'status');
        choice.input.setAttribute('aria-describedby', choice.input.getAttribute('aria-describedby') + ' ocr-cross-' + choice.key);
        choice.crossWarning.id = 'ocr-cross-' + choice.key;
        choice.status.after(choice.crossWarning);
      }
      choice.crossWarning.hidden = !mismatch;
      choice.crossWarning.textContent = mismatch
        ? '台灣占比 ' + tw.value + '% 與國家列表的台灣 ' + listedTw[1] + '% 不一致，請修正其中一處。'
        : '';
    }
    const selected = choices.filter((c) => c.check.checked);
    const unresolved = choices.filter((choice) => choice.needsReview || choice.error);
    const skipped = choices.filter((choice) => choice.needsReview && !choice.check.checked);
    const nextSignature = skipped.map((choice) => choice.key).join('|');
    if (nextSignature !== skipSignature) skipAck.checked = false;
    skipSignature = nextSignature;
    skipLabel.hidden = applied || !skipped.length;
    skipText.textContent =
      '我選擇略過未完成欄位：' + skipped.map((choice) => screenshotFields[choice.key]).join('、') + '。這些值不會填入，之後可在表單補登。';
    const allIdentical = choices.every((choice) => choice.before && sameValue(choice.key, choice.value, choice.before));
    if (countryNotice)
      countryNotice.textContent = unresolved.some((c) => c.key === 'taiwan')
        ? '・台灣未讀到'
        : unresolved.some((c) => c.key === 'countries')
          ? '・國家待補正'
          : choices.find((c) => c.key === 'countries')?.partialAccepted
            ? '・已確認只填部分國家（' + choices.find((c) => c.key === 'countries').coverage.toFixed(2) + '%，仍不完整）'
            : '・國家數值已補正';
    count.textContent = choices.length + ' 欄 · 數值疑點 ' + unresolved.length;
    shortcutCount.textContent = '已選 ' + selected.length + ' 欄' + (unresolved.length ? ' · 數值疑點 ' + unresolved.length : '');
    jumpMissing.hidden = !unresolved.length;
    jumpMissing.textContent = (applied ? '到表單補登 ' : '需補正 ') + unresolved.length + ' 項 →';
    selectionCount.textContent = '已選 ' + selected.length + ' / ' + choices.length;
    for (const choice of choices) {
      const same = Boolean(choice.before) && sameValue(choice.key, choice.value, choice.before);
      choice.row.classList.toggle('is-identical', same);
      choice.row.classList.toggle('is-overwrite', Boolean(choice.before) && !same && choice.check.checked);
      if (!applied && !choice.needsReview && !choice.row.classList.contains('has-error')) {
        if (same) choice.status.textContent = '與目前相同，無需覆寫';
        else if (choice.before)
          choice.status.textContent = choice.check.checked
            ? '將覆寫：' +
              comparisonValue(choice.key, choice.before) +
              choice.unit +
              ' → ' +
              comparisonValue(choice.key, choice.value) +
              choice.unit
            : '與目前不同，保留原值；勾選才覆寫';
        if (choice.refreshed) choice.status.textContent = '表單剛變更；' + choice.status.textContent;
      }
      choice.row.classList.toggle('is-selected', choice.check.checked);
      choice.row.classList.toggle('is-missing', choice.needsReview);
      if (choice.error) {
        choice.status.textContent = choice.error.message;
        choice.row.classList.add('has-error');
        if (choice.error.invalid) choice.input.setAttribute('aria-invalid', 'true');
      }
    }
    preflight.replaceChildren();
    const pending = [];
    for (const choice of choices.filter((entry) => entry.error || (entry.check.checked && entry.needsReview))) {
      const message = choice.error?.message || '補齊或確認只填部分國家';
      pending.push([
        message.startsWith(screenshotFields[choice.key]) ? message : screenshotFields[choice.key] + '：' + message,
        () => revealChoice(choice),
      ]);
    }
    if (!confirmed.checked) pending.push(['確認網站、月份與裝置範圍', () => confirmed.focus()]);
    if (skipped.length && !skipAck.checked)
      pending.push(['確認略過：' + skipped.map((choice) => screenshotFields[choice.key]).join('、'), () => skipAck.focus()]);
    preflight.hidden = applied || !pending.length;
    if (pending.length) {
      preflight.append(text('strong', '填入前還有 ' + pending.length + ' 項待完成'));
      const list = document.createElement('ul');
      for (const [label, navigate] of pending) {
        const item = document.createElement('li');
        const link = text('button', label);
        link.type = 'button';
        link.addEventListener('click', navigate);
        item.append(link);
        list.append(item);
      }
      preflight.append(list);
    }
    apply.disabled = applied || stale || !confirmed.checked || (!selected.length && !allIdentical);
    const blocked = choices.some((choice) => choice.error || (choice.check.checked && choice.needsReview));
    apply.classList.toggle('primary', !blocked);
    apply.textContent = blocked ? '填入勾選欄位' : !selected.length && allIdentical ? '完成核對，保留表單' : '填入勾選欄位';
    if (!applied)
      applyStatus.textContent = stale
        ? '請先更新目前內容，再確認要覆寫的欄位。'
        : !selected.length && allIdentical
          ? '數值皆與表單相同；確認網站、月份與範圍後可完成核對。'
          : !selected.length
            ? '請先勾選至少一個要填入的欄位。'
            : pending.length
              ? '請先完成上方 ' + pending.length + ' 項待辦，再填入表單。'
              : !confirmed.checked
                ? '請勾選上方確認：網站、月份與裝置範圍。'
                : selected.length +
                  ' 個欄位將填入 ' +
                  targetLabel +
                  (selected.some((c) => c.before) ? '，覆寫 ' + selected.filter((c) => c.before).length + ' 欄' : '') +
                  ' · 尚未儲存';
  }
  confirmed.addEventListener('change', updateSelection);
  skipAck.addEventListener('change', updateSelection);
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
      if (choice.namedError) {
        fail(choice.namedError, choice);
        return;
      }
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
    const changed = (selected.length ? selected : choices).filter((c) => latest[c.key] !== c.before);
    if (changed.length) {
      fail(
        '核對期間表單內容已變更：' +
          changed.map((c) => screenshotFields[c.key]).join('、') +
          '。請更新目前內容；核對修正會保留，變更欄位預設不覆寫。',
      );
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
      shares.some((row) => !row || Number(row[2]) > 100 || !screenshotSelectableCountryCodes.includes(row[1].toUpperCase())) ||
      new Set(shares.filter(Boolean).map((row) => row[1].toUpperCase())).size !== shares.length
    ) {
      fail('國家占比請每行填不重複的國家代碼與 0–100 百分比，例如 TW 93.23。', countryChoice);
      if (countryChoice) {
        countryChoice.row.querySelector('.ocr-country-raw').open = true;
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
    if (choices.some((choice) => choice.needsReview && !choice.check.checked) && !skipAck.checked) {
      fail('有未完成欄位尚未填入：請補正，或勾選上方「略過」確認。');
      skipAck.focus();
      skipLabel.scrollIntoView({ block: 'center' });
      return;
    }
    if (taiwanChoice && countryChoice && !listedTw) {
      countryChoice.value = 'TW ' + taiwanChoice.value + (lines.length ? '\n' + lines.join('\n') : '');
      countryChoice.input.value = countryChoice.value;
    }
    const previousMonth = month.value;
    if (month.value !== targetMonth) {
      month.value = targetMonth;
      month.dispatchEvent(new Event('change', { bubbles: true }));
    }
    for (const { key, value } of selected) {
      const field = form.elements.namedItem(key);
      field.value = value;
      field.dataset.ocrFilled = 'true';
    }
    for (const { key } of choices) {
      const field = form.elements.namedItem(key);
      const source = [...new Set((result.sources?.[key] || []).map((s) => '截圖 ' + (s.image + 1)))].join('、');
      const back = text('button', screenshotFields[key] + ' · ' + (source || '手動補正') + ' · 回到原圖核對 ↖', 'ocr-form-source');
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
    updateMonthNotice();
    right.classList.add('is-applied');
    startReview.hidden = true;
    right.querySelector('.ocr-results-hint').textContent = selected.length
      ? '已填入表單；此處保留核對結果。需要修改時，請回到表單。'
      : '核對完成，表單內容未更動。';
    reviewDirty = false;
    updateSaveHandoff(false);
    updateTarget();
    shortcut.hidden = true;
    bulkTools.hidden = true;
    for (const button of tools.querySelectorAll('button')) button.disabled = true;
    for (const choice of choices) {
      choice.check.disabled = true;
      choice.input.readOnly = true;
      choice.status.textContent = choice.check.checked ? '' : '未填入';
      choice.renderCountryRows?.();
      if (!selected.length) choice.status.textContent = '與表單相同，已完成核對';
      if (choice.countryHelper) choice.countryHelper.hidden = true;
      if (choice.unmatched)
        for (const button of choice.unmatched.querySelectorAll('button'))
          button.textContent = button.textContent.replace('補上原圖', '到表單補上原圖');
      if (choice.key === 'countries' && !choice.check.checked && choice.value && choice.needsReview) {
        const repair = text('div', '', 'ocr-partial-repair');
        const retained = choice.value.split('\n').filter(Boolean).length;
        const restore = text('button', '帶入已讀到的 ' + retained + ' 個國家，繼續補正');
        restore.type = 'button';
        const evidence = text('div', '', 'ocr-inline-evidence');
        renderEvidence(choice, evidence);
        const repairStatus = text('p', '國家列表尚未填入；可沿用已辨識的部分，再補上缺少的國家。');
        repairStatus.setAttribute('role', 'status');
        repair.append(repairStatus, evidence, restore);
        restore.addEventListener('click', () => {
          const currentLines = formCountries.value.split('\n').filter(Boolean);
          const currentCodes = new Set(currentLines.map((line) => line.trim().split(/\s+/)[0].toUpperCase()));
          const additions = choice.value.split('\n').filter((line) => line && !currentCodes.has(line.trim().split(/\s+/)[0].toUpperCase()));
          const kept = choice.value.split('\n').filter((line) => line && currentCodes.has(line.trim().split(/\s+/)[0].toUpperCase()));
          formCountries.value = [...currentLines, ...additions].join('\n');
          formCountries.dispatchEvent(new Event('input', { bubbles: true }));
          repairStatus.textContent =
            (additions.length ? '已帶入：' + readableCountries(additions.join('、')) + '。' : '沒有新增國家。') +
            (kept.length ? '已有國家的草稿值已保留。' : '') +
            '列表仍不完整，請對照原圖補上缺項；尚未儲存。';
          restore.hidden = true;
          if (additions.length) {
            const undo = text('button', '復原這次帶入的國家');
            undo.type = 'button';
            repair.append(undo);
            undo.addEventListener('click', () => {
              formCountries.value = formCountries.value
                .split('\n')
                .filter((line) => !additions.includes(line))
                .join('\n');
              formCountries.dispatchEvent(new Event('input', { bubbles: true }));
              undo.remove();
              restore.hidden = false;
              repairStatus.textContent = '已復原這次帶入，保留其後編輯過的國家；可重新帶入。';
              restore.focus();
            });
          }
          formCountryHelper.open = true;
          formCountryTools.search.focus();
          formCountryHelper.scrollIntoView({ block: 'center' });
        });
        formCountries.closest('.field').insertBefore(repair, formCountryHelper);
      }
      choice.previous.textContent = choice.before ? '填入前：' + comparisonValue(choice.key, choice.before) + choice.unit : '';
      if (choice.key === 'countries' && countryAcknowledgement) countryAcknowledgement.closest('label').hidden = true;
    }
    confirmation.hidden = true;
    jumpConfirm.textContent = selected.length ? '前往表單儲存 ↓' : '回到表單 ↓';
    selectField(activeKey, false);
    apply.hidden = true;
    const next = text('button', selected.length ? '前往表單儲存 ↓' : '回到表單 ↓', 'primary');
    next.type = 'button';
    next.addEventListener('click', goToHandoff);
    actionLine.prepend(next);
    next.focus({ preventScroll: true });
    const omitted = choices.filter((choice) => choice.needsReview && !choice.check.checked).map((choice) => screenshotFields[choice.key]);
    applyStatus.textContent = selected.length
      ? '已填入 ' +
        selected.length +
        ' 個欄位，尚未儲存。' +
        (omitted.length ? '未填入：' + omitted.join('、') + '；請在表單補登。' : '原圖與核對結果保留在上方。')
      : '數值皆與表單相同，核對完成；表單內容未更動。';
    if (choices.some((choice) => choice.key === 'countries' && choice.partialAccepted && choice.check.checked))
      applyStatus.textContent += ' 國家列表僅填入已確認的部分，仍不完整。';
    if (previousMonth !== targetMonth)
      applyStatus.textContent +=
        ' 已切換至 ' + targetLabel + '；' + previousMonth.slice(0, 4) + '/' + previousMonth.slice(4) + ' 草稿保留。';
    progress.textContent = applyStatus.textContent;
    setStep('save');
    updateSelection();
  });
  const startReview = text('button', '開始核對 ↓', 'primary ocr-start-review');
  startReview.type = 'button';
  startReview.addEventListener('click', () => revealChoice(choices.find((choice) => choice.needsReview) || choices[0], false));
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
  review.setAttribute('aria-busy', 'true');
  host.classList.add('is-recognizing');
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
    review.removeAttribute('aria-busy');
    host.classList.remove('is-recognizing');
    recognize.disabled = false;
    fileInput.disabled = false;
    renderFiles();
    if (!review.childElementCount) {
      setStep('select');
      recognize.focus();
    }
  }
});
