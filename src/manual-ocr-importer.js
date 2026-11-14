import {
  mergeScreenshots,
  parseScreenshot,
  refineScreenshotNumbers,
  reviewScreenshotCountries,
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
function renderFormCountries() {
  const names = new Intl.DisplayNames(['zh-Hant'], { type: 'region' });
  const listedTw = /^TW\s+(\d+(?:\.\d+)?)$/m.exec(formCountries.value);
  const mismatch = formTaiwan.value && listedTw && Number(formTaiwan.value) !== Number(listedTw[1]);
  const basicError = valueError('taiwan', formTaiwan.value);
  if (formTaiwan.value !== serverTaiwanValue) serverTaiwanInvalid = false;
  formCountryWarning.hidden = !mismatch;
  formCountryWarning.textContent = mismatch
    ? '台灣占比 ' + formTaiwan.value + '% 與國家列表的台灣 ' + listedTw[1] + '% 不一致，請先修正再儲存。'
    : '';
  formTaiwan.setCustomValidity(basicError || (mismatch ? formCountryWarning.textContent : ''));
  formTaiwan.setAttribute('aria-invalid', String(Boolean(mismatch || basicError || serverTaiwanInvalid)));
  formTaiwanWarning.hidden = !mismatch && !basicError;
  formTaiwanWarning.textContent = basicError || formCountryWarning.textContent;
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
  for (const restore of form.querySelectorAll('[data-country-reuse]')) restore.dispatchEvent(new Event('manual:refresh-reuse'));
}
form.addEventListener('input', renderFormCountries);
form.addEventListener('change', renderFormCountries);
form.addEventListener('manual:values-changed', renderFormCountries);
formCountryRows.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || event.target.tagName !== 'INPUT') return;
  event.preventDefault();
  const inputs = [...formCountryRows.querySelectorAll('input')];
  const next = inputs[inputs.indexOf(event.target) + 1];
  if (next) next.focus();
  else {
    formCountryHelper.open = true;
    formCountryTools.search.focus();
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
formCountryRaw.after(formCountryHelper);
const base = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
let busy = false;
let images = [];
let reviewDirty = false;
let pendingReview = false;
let reviewMonthChange;
let reviewFormChange;
const saveBar = form.querySelector('.manual-save-bar');
const saveHint = saveBar.querySelector('span');
const defaultSaveHint = saveHint.textContent;
let formValidationMessage = '';
const saveWarning = document.createElement('div');
saveWarning.className = 'ocr-save-warning';
saveWarning.hidden = true;
saveBar.after(saveWarning);
function updateSaveHandoff(pending) {
  pendingReview = pending;
  form.dispatchEvent(new CustomEvent('manual:review-state', { detail: { pending } }));
  saveHint.textContent = pending ? '先完成上方截圖核對並填入，再儲存此月份。' : formValidationMessage || defaultSaveHint;
  saveHint.hidden = false;
  for (const button of form.querySelectorAll('[type=submit]')) button.classList.toggle('primary', !pending);
  saveWarning.hidden = true;
}
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
    if (entries.some(({ control }) => control.value) && !desktop) form.querySelector('[data-all-channels]').open = true;
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
  if (!pendingReview) saveHint.textContent = formValidationMessage || defaultSaveHint;
}
form.addEventListener('input', validateFormValues);
form.addEventListener('change', validateFormValues);
form.addEventListener('manual:values-changed', validateFormValues);
validateFormValues();
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
  if (reviewFormChange) form.removeEventListener('input', reviewFormChange);
  reviewMonthChange = null;
  reviewFormChange = null;
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
  review.className = 'ocr-map-review';
  if (result.months.length > 1) throw Error('截圖包含不同月份，請只選同一個月份的截圖。');
  const targetMonth = result.months[0] || month.value;
  if (![...month.options].some((option) => option.value === targetMonth)) throw Error('截圖月份超出可補登範圍，請確認日期。');
  const targetLabel = targetMonth.slice(0, 4) + '/' + targetMonth.slice(4);
  const current = () => {
    const detail = { month: targetMonth, values: null };
    form.dispatchEvent(new CustomEvent('manual:read-month', { detail }));
    if (!detail.values) throw Error('表單尚未就緒，請重新整理後再試。');
    return detail.values;
  };
  let before = current();
  let applied = false;
  let activePanel = 0;
  let zoomed = false;
  const rows = [];
  let nextRowId = 0;
  const panels = [];
  const sources = (key) => [...(result.sources?.[key] || []), ...(result.uncertainSources?.[key] || [])];
  const button = (label, action, className = '') => {
    const node = text('button', label, className);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  };
  const countryName = (code) => countryDisplayNames.of(code);
  const regionCountry = (code) => sources('countries').filter((region) => region.value.startsWith(code + ' '));
  const addRow = (key, value, regions, code = '') => {
    const row = {
      id: nextRowId++,
      key,
      code,
      value,
      initial: value,
      regions,
      label: code ? (code === 'TW' ? '台灣占比' : countryName(code)) : screenshotFields[key],
      group:
        code || key === 'countries' ? 1 : ['visits', 'pages', 'duration', 'bounce'].includes(key) ? 0 : key.startsWith('desktop_') ? 3 : 2,
      skipped: false,
      flagged: false,
      override: false,
      controls: [],
      imageHint: result.countryContexts?.[0]?.image || 0,
    };
    rows.push(row);
    return row;
  };
  const keys = new Set(Object.keys(result.fields).filter((key) => screenshotFields[key]));
  for (const key of Object.keys(screenshotFields))
    if (
      result.warnings.some((warning) => {
        const message = warning.replace(/^截圖 \d+：/, '');
        return (
          (message.startsWith(screenshotFields[key]) || message.startsWith('不同截圖的' + screenshotFields[key])) &&
          /不一致|不夠清楚|未能確定|多個不同數值/.test(message)
        );
      })
    )
      keys.add(key);
  if (['visits', 'pages', 'duration', 'bounce'].filter((key) => keys.has(key)).length >= 2)
    for (const key of ['visits', 'pages', 'duration', 'bounce']) keys.add(key);
  for (const key of keys) {
    if (['countries', 'taiwan'].includes(key)) continue;
    addRow(key, result.fields[key] || '', sources(key));
  }
  const countryValues = new Map(
    (result.fields.countries || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.trim().split(/\s+/)),
  );
  if (result.fields.taiwan !== undefined || result.countryTable) {
    const twValue = result.fields.taiwan || countryValues.get('TW') || '';
    addRow('taiwan', twValue, sources('taiwan').length ? sources('taiwan') : regionCountry('TW'), 'TW');
    countryValues.delete('TW');
  }
  for (const [code, value] of countryValues) addRow('countries', value, regionCountry(code), code);
  for (const unknown of result.unmatchedCountries || []) {
    const contexts = (result.countryContexts || []).filter((region) => region.image === unknown.image);
    const row = addRow('countries', unknown.share, contexts[unknown.row - 1] ? [contexts[unknown.row - 1]] : []);
    row.label = '截圖 ' + ((unknown.image || 0) + 1) + '・第 ' + unknown.row + ' 列國家';
  }
  const countryRows = () => rows.filter((row) => row.group === 1);
  const contextUsed = (region) =>
    countryRows().some((row) => row.regions.some((r) => r.image === region.image && Math.abs(r.y - region.y) < 20));
  if (result.countryTable) {
    for (const region of result.countryContexts || []) {
      if (contextUsed(region)) continue;
      const emptyTw = rows.find((row) => row.code === 'TW' && !row.regions.length);
      if (emptyTw) emptyTw.regions = [region];
      else if (countryRows().length < (result.countryExpectedCount || 0)) {
        const row = addRow('countries', '', [region]);
        row.label = '待辨識國家';
      }
    }
  }
  if (!rows.length) throw Error('沒有辨識到可補登的數值，請改用清楚的概況、國家或流量來源截圖。');
  const expectedCountries = result.countryExpectedCount || 0;
  const countryUncertain = Boolean(
    result.countryTable &&
      (countryRows().some((row) => !row.code || !row.value) ||
        expectedCountries > countryRows().length ||
        result.warnings.some((w) => /國家.*(?:漏辨識|不一致)/.test(w))),
  );
  const heading = text('div', '', 'ocr-review-heading');
  heading.tabIndex = -1;
  const title = text('div');
  title.append(
    text('h3', '核對辨識結果'),
    text('p', host.dataset.domain + ' · ' + targetLabel + ' · ' + images.length + ' 張截圖', 'ocr-target'),
  );
  const count = text('span', '', 'ocr-count');
  heading.append(title, count);
  review.append(
    heading,
    text('p', '沿著原圖掃讀右側辨識值；錯了直接改，不確定就標記待查。看完後整批填入，不必逐欄確認。', 'ocr-map-intro'),
  );
  const warnings = [...new Set(result.warnings)];
  if (!result.months.length) warnings.unshift('未讀到月份，將使用表單月份 ' + targetLabel + '。');
  const scopeWarnings = warnings.filter((warning) => /未完整辨識|未讀到月份|未能確認|請改用/.test(warning));
  if (warnings.length) {
    const notice = document.createElement('details');
    notice.className = 'ocr-notices';
    notice.append(text('summary', '截圖範圍與辨識提示（' + warnings.length + '）'));
    for (const warning of warnings) notice.append(text('p', warning));
    review.append(notice);
  }
  const toolbar = text('div', '', 'ocr-map-toolbar');
  const nav = text('nav', '', 'ocr-map-tabs');
  nav.setAttribute('aria-label', '原圖核對區塊');
  const tools = text('div', '', 'ocr-map-tools');
  const zoom = button('放大比對', () => {
    zoomed = !zoomed;
    board.classList.toggle('is-zoomed', zoomed);
    zoom.textContent = zoomed ? '恢復大小' : '放大比對';
    zoom.setAttribute('aria-pressed', String(zoomed));
    layout();
  });
  zoom.setAttribute('aria-pressed', 'false');
  const full = button('查看完整原圖', () => openOriginal(panels[activePanel]?.image || 0, null, full));
  tools.append(zoom, full);
  toolbar.append(nav, tools);
  const board = text('div', '', 'ocr-map-board');
  const issueLinks = text('div', '', 'ocr-map-issues');
  issueLinks.setAttribute('aria-label', '待處理項目');
  const recovery = text('div', '', 'ocr-map-recovery');
  const footer = text('div', '', 'ocr-map-footer');
  const policy = text('label', '', 'ocr-map-policy');
  const overwrite = document.createElement('input');
  overwrite.type = 'checkbox';
  policy.append(overwrite, document.createTextNode('使用截圖更新已有數值（預設保留表單內容）'));
  overwrite.addEventListener('change', () => {
    reviewDirty = true;
    update();
  });
  const partialLabel = text('label', '', 'ocr-map-policy');
  const partial = document.createElement('input');
  partial.type = 'checkbox';
  partialLabel.append(partial, document.createTextNode('只填已讀到的國家，略過未完成的國家列（列表仍不完整）'));
  partialLabel.hidden = !countryUncertain;
  partial.addEventListener('change', () => {
    reviewDirty = true;
    update();
  });
  const scope = text(
    'p',
    '填入即確認：截圖屬於 ' + host.dataset.domain + '、' + targetLabel + '，以及各區塊標示的全裝置／桌面限定範圍。',
    'ocr-map-scope',
  );
  if (scopeWarnings.length) scope.append(text('span', ' 部分篩選或月份未完整讀到，請對照上方原圖確認。'));
  const summary = text('p', '', 'ocr-map-summary');
  const status = text('p', '', 'ocr-map-status');
  status.id = 'ocr-apply-status';
  status.setAttribute('role', 'status');
  const actionLine = text('div', '', 'ocr-map-action-line');
  const apply = button('核對完成，整批填入', applyValues, 'primary');
  apply.id = 'ocr-apply';
  apply.setAttribute('aria-describedby', 'ocr-apply-status');
  const handoff = button(
    '前往表單儲存 ↓',
    () => {
      if (month.value !== targetMonth) {
        month.value = targetMonth;
        month.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const field = form.elements.namedItem('visits');
      field.scrollIntoView({ block: 'center' });
      field.focus({ preventScroll: true });
    },
    'primary',
  );
  handoff.hidden = true;
  const refresh = button('更新表單比較，保留核對修正', () => {
    before = current();
    overwrite.checked = false;
    update();
  });
  refresh.hidden = true;
  actionLine.append(apply, handoff, refresh, status);
  footer.append(policy, partialLabel, scope, summary, actionLine);
  review.append(toolbar, board, issueLinks, recovery, footer);
  // Keep a single integration target for the pending-save guard.
  const shortcut = text('div', '', 'ocr-review-shortcut');
  shortcut.hidden = true;
  shortcut.append(
    button('回到核對結果', () => {
      footer.scrollIntoView({ block: 'center' });
      (applied ? handoff : apply).focus();
    }),
  );
  review.append(shortcut);

  function oldValue(row) {
    if (row.code) {
      const listed = /^([A-Z]{2})\s+(.+)$/.exec((before.countries || '').split('\n').find((line) => line.startsWith(row.code + ' ')) || '');
      return row.code === 'TW' ? before.taiwan || listed?.[2] || '' : listed?.[2] || '';
    }
    return before[row.key] || '';
  }
  function usesScreenshot(row) {
    return row.override || overwrite.checked || !oldValue(row);
  }
  function rowError(row) {
    if (row.skipped || (partial.checked && row.group === 1 && (!row.code || !row.value))) return '';
    if (!row.code && row.group === 1) return '請選擇原圖中的國家名稱，或選擇只填已讀國家。';
    if (!row.value)
      return row.regions.some((r) => r.value && !/上下文|範圍/.test(r.value))
        ? '讀到不同或不確定的數值，請選用來源或修正。'
        : '未讀到數值，請補上或略過此欄。';
    return valueError(row.code ? 'taiwan' : row.key, row.value);
  }
  function prospective() {
    const values = { ...before };
    const countryMap = new Map(
      (before.countries || '')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.trim().split(/\s+/)),
    );
    let touchedCountries = false;
    for (const row of rows) {
      if (row.skipped || !row.value || rowError(row)) continue;
      if (row.code) {
        if (usesScreenshot(row)) {
          if (result.countryTable || row.key === 'countries') {
            countryMap.set(row.code, row.value);
            touchedCountries = true;
          }
          if (row.code === 'TW') values.taiwan = row.value;
        } else if (row.code === 'TW' && !values.taiwan) values.taiwan = oldValue(row);
      } else if (usesScreenshot(row)) values[row.key] = row.value;
    }
    if (touchedCountries) values.countries = [...countryMap].map(([code, value]) => code + ' ' + value).join('\n');
    // One Taiwan editor drives both representations when a new country list is filled.
    if (
      touchedCountries &&
      values.taiwan &&
      !countryMap.has('TW') &&
      rows.some((row) => row.code === 'TW' && !row.skipped && !rowError(row))
    )
      values.countries = 'TW ' + values.taiwan + (values.countries ? '\n' + values.countries : '');
    return values;
  }
  function problems(values) {
    const issues = [];
    for (const row of rows) {
      const message = rowError(row);
      if (message) issues.push({ row, message });
      if (row.flagged) issues.push({ row, message: '已標記待查，請處理後取消標記。' });
    }
    const codes = new Set();
    for (const row of countryRows().filter((row) => row.code && !row.skipped)) {
      if (codes.has(row.code)) issues.push({ row, message: '國家重複，請更正或略過這一列。' });
      codes.add(row.code);
    }
    for (const [key, value] of Object.entries(values)) {
      const error = screenshotFields[key] && valueError(key, value);
      if (error) issues.push({ row: rows.find((row) => row.key === key), message: screenshotFields[key] + '：' + error });
    }
    for (const desktop of [false, true]) {
      const keys = Object.keys(screenshotFields).filter(
        (key) => key.startsWith('desktop_') === desktop && !['visits', 'pages', 'duration', 'bounce', 'taiwan', 'countries'].includes(key),
      );
      const total = keys.reduce((sum, key) => sum + Number(values[key] || 0), 0);
      if (total > 100.1)
        issues.push({
          row: rows.find((row) => keys.includes(row.key)),
          message: (desktop ? '桌面限定' : '全裝置') + '流量來源合計 ' + total.toFixed(2) + '%，超過 100%。請核對保留值與截圖值。',
        });
    }
    const countries = (values.countries || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.trim().split(/\s+/));
    const tw = countries.find(([code]) => code === 'TW');
    if (tw && values.taiwan && Number(tw[1]) !== Number(values.taiwan))
      issues.push({
        row: rows.find((row) => row.code === 'TW'),
        message: '將填入的台灣占比 ' + values.taiwan + '% 與保留的國家列表台灣 ' + tw[1] + '% 不一致。請修改表單或使用截圖更新已有數值。',
      });
    const total = countries.reduce((sum, [, share]) => sum + Number(share), 0) + (tw ? 0 : Number(values.taiwan || 0));
    if (total > 100.1) issues.push({ row: countryRows()[0], message: '國家占比合計 ' + total.toFixed(2) + '%，超過 100%。' });
    if (
      countryUncertain &&
      !partial.checked &&
      (expectedCountries > countryRows().filter((row) => row.code && row.value && !row.skipped).length ||
        countryRows().some((row) => row.skipped))
    )
      issues.push({
        row: countryRows().find((row) => row.skipped || !row.code || !row.value),
        message: '國家列表仍不完整，請補齊，或選擇只填已讀國家。',
      });
    return issues;
  }
  function changedFields(values) {
    return Object.keys(screenshotFields).filter((key) => values[key] && !sameValue(key, values[key], before[key] || ''));
  }
  function staleFields() {
    const latest = current();
    return Object.keys(screenshotFields).filter((key) => (latest[key] || '') !== (before[key] || ''));
  }
  function update() {
    const values = prospective();
    const issues = problems(values);
    const stale = !applied && staleFields();
    const changed = changedFields(values);
    const edits = rows.filter((row) => row.value !== row.initial).length;
    count.textContent =
      rows.length +
      ' 個辨識值' +
      (edits ? ' · 已修改 ' + edits : '') +
      (rows.some((row) => row.flagged) ? ' · 待查 ' + rows.filter((row) => row.flagged).length : '');
    const kept = rows.filter(
      (row) => !row.skipped && oldValue(row) && !usesScreenshot(row) && !sameValue(row.code ? 'taiwan' : row.key, row.value, oldValue(row)),
    ).length;
    policy.hidden = applied || !rows.some((row) => oldValue(row));
    summary.textContent = applied
      ? '核對結果保留於此；需要修改請回到表單。'
      : changed.length +
        ' 個表單欄位將填入' +
        (kept ? ' · ' + kept + ' 個已有數值保留' : '') +
        (rows.some((row) => row.skipped)
          ? ' · 略過：' +
            rows
              .filter((row) => row.skipped)
              .map((row) => row.label)
              .join('、')
          : '');
    apply.textContent = changed.length ? '核對完成，整批填入 ' + changed.length + ' 欄 →' : '核對完成，保留表單內容';
    apply.disabled = issues.length > 0 || Boolean(stale.length);
    apply.hidden = applied;
    handoff.hidden = !applied;
    refresh.hidden = applied || !stale.length;
    status.textContent = applied
      ? month.value === targetMonth
        ? '已完成核對；尚未儲存。'
        : '表單目前是其他月份，前往表單將返回 ' + targetLabel + '。'
      : stale.length
        ? '表單已變更：' + stale.map((key) => screenshotFields[key]).join('、') + '。請先更新比較。'
        : issues.length
          ? '尚有 ' + issues.length + ' 項需處理；請見下方提示。'
          : '看完原圖後按一次填入，接著在表單儲存。';
    issueLinks.replaceChildren();
    if (!applied)
      for (const issue of issues)
        issueLinks.append(
          button((issue.row ? issue.row.label + '：' : '') + issue.message, () =>
            issue.row ? locate(issue.row) : footer.scrollIntoView({ block: 'center' }),
          ),
        );
    for (const row of rows)
      for (const control of row.controls) {
        const error = rowError(row);
        control.card.classList.toggle('is-edited', row.value !== row.initial);
        control.card.classList.toggle('is-flagged', row.flagged);
        control.card.classList.toggle('has-error', Boolean(error));
        control.card.classList.toggle('is-skipped', row.skipped);
        if (document.activeElement !== control.input) control.input.value = row.value;
        control.input.readOnly = applied;
        control.input.setAttribute('aria-invalid', String(Boolean(error)));
        control.flag.disabled = applied;
        control.flag.setAttribute('aria-pressed', String(row.flagged));
        control.flag.textContent = row.flagged ? '待查中' : '?';
        control.flag.setAttribute('aria-label', (row.flagged ? '取消待查・' : '標記待查・') + row.label);
        control.note.textContent = applied
          ? row.skipped
            ? '已略過，未填入'
            : ''
          : error ||
            (row.skipped
              ? '此欄將略過'
              : oldValue(row) && !usesScreenshot(row)
                ? '保留表單：' + oldValue(row)
                : row.value !== row.initial
                  ? '已修改'
                  : '');
        control.skip.hidden = applied;
        control.skip.textContent = row.skipped ? '恢復填入' : '略過此欄';
        control.select && (control.select.disabled = applied);
        for (const candidate of control.candidates) candidate.disabled = applied;
      }
    if (panels[activePanel]) requestAnimationFrame(layout);
  }
  function locate(row) {
    const index = panels.findIndex((panel) => panel.rows.includes(row));
    if (index >= 0 && index !== activePanel) {
      activePanel = index;
      renderPanel();
    }
    const control = row.controls[0];
    if (control) {
      control.card.scrollIntoView({ block: 'center', inline: 'nearest' });
      (control.select && !row.code ? control.select : control.input).focus({ preventScroll: true });
    }
  }
  function openOriginal(index, region, opener) {
    const dialog = text('dialog', '', 'ocr-original-dialog');
    const bar = text('div', '', 'ocr-dialog-toolbar');
    const close = button('返回核對', () => dialog.close());
    const image = new Image();
    image.src = images[index].url;
    image.alt = '截圖 ' + (index + 1) + '・' + images[index].file.name;
    const stage = text('div', '', 'ocr-dialog-stage');
    stage.append(image);
    if (region) {
      const marker = text('div', '', 'ocr-dialog-marker');
      const bounds = region.valueBox || region;
      Object.assign(marker.style, {
        left: ((bounds.x - 10) / images[index].width) * 100 + '%',
        top: ((bounds.y - 10) / images[index].height) * 100 + '%',
        width: ((bounds.w + 20) / images[index].width) * 100 + '%',
        height: ((bounds.h + 20) / images[index].height) * 100 + '%',
      });
      stage.append(marker);
    }
    const viewport = text('div', '', 'ocr-dialog-image');
    viewport.append(stage);
    bar.append(
      text('strong', image.alt),
      button('放大／縮小', () => stage.classList.toggle('is-zoomed')),
      close,
    );
    dialog.append(bar, viewport);
    review.append(dialog);
    dialog.addEventListener(
      'close',
      () => {
        dialog.remove();
        opener?.focus({ preventScroll: true });
      },
      { once: true },
    );
    dialog.showModal();
    close.focus();
    image.addEventListener('load', () => stage.querySelector('.ocr-dialog-marker')?.scrollIntoView({ block: 'center', inline: 'center' }), {
      once: true,
    });
  }
  function buildPanels() {
    panels.length = 0;
    const labels = ['概況與互動', '國家分布', '全裝置流量來源', '桌面限定流量來源 · Desktop Only'];
    for (let image = 0; image < images.length; image++)
      for (let group = 0; group < labels.length; group++) {
        const members = rows.filter((row) => row.group === group && (row.regions[0]?.image ?? row.imageHint ?? 0) === image);
        if (members.length)
          panels.push({
            image,
            group,
            rows: members.sort((a, b) => (a.regions[0]?.y ?? Infinity) - (b.regions[0]?.y ?? Infinity)),
            label: '截圖 ' + (image + 1) + ' · ' + labels[group],
          });
      }
    activePanel = Math.min(activePanel, panels.length - 1);
    nav.replaceChildren(
      ...panels.map((panel, index) => {
        const tab = button(panel.label, () => {
          activePanel = index;
          renderPanel();
        });
        tab.setAttribute('aria-pressed', String(index === activePanel));
        return tab;
      }),
    );
  }
  const pictureCache = new Map();
  function loadPicture(index) {
    if (!pictureCache.has(index))
      pictureCache.set(
        index,
        (async () => {
          const picture = new Image();
          picture.src = images[index].url;
          await picture.decode();
          return picture;
        })(),
      );
    return pictureCache.get(index);
  }
  function makeControl(row, panel) {
    const card = text('div', '', 'ocr-map-field');
    card.dataset.field = row.code ? (row.code === 'TW' ? 'taiwan' : 'country-' + row.code) : row.key;
    const head = text('div', '', 'ocr-map-field-head');
    const label = button(
      row.label,
      () =>
        openOriginal(
          panel.image,
          row.regions.find((region) => region.image === panel.image),
          label,
        ),
      'ocr-map-field-label',
    );
    const flag = button(
      '?',
      () => {
        row.flagged = !row.flagged;
        reviewDirty = true;
        update();
      },
      'ocr-map-flag',
    );
    head.append(label, flag);
    const line = text('div', '', 'ocr-map-value-line');
    const crop = document.createElement('canvas');
    crop.className = 'ocr-map-crop';
    crop.setAttribute('role', 'img');
    crop.setAttribute('aria-label', row.label + '的原圖數字');
    crop.hidden = true;
    const input = document.createElement('input');
    input.value = row.value;
    input.setAttribute('aria-label', '核對' + row.label);
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.inputMode = ['visits', 'duration'].includes(row.key) ? 'text' : 'decimal';
    input.placeholder = row.regions.some((region) => region.value && !/上下文|範圍/.test(region.value)) ? '請選用或修正' : '未讀到';
    input.addEventListener('input', () => {
      row.value = input.value.trim().replace(/%$/, '');
      row.override = true;
      row.skipped = false;
      reviewDirty = true;
      update();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        input.blur();
      }
    });
    const unit = ['visits', 'duration'].includes(row.key) ? '' : row.key === 'pages' ? '頁' : '%';
    line.append(crop, input, text('span', unit, 'ocr-map-unit'));
    const note = text('p', '', 'ocr-map-field-note');
    note.id = 'ocr-map-error-' + row.id;
    input.setAttribute('aria-describedby', note.id);
    const extra = document.createElement('details');
    extra.className = 'ocr-map-field-extra';
    const menuLabel = text('summary', '⋯');
    menuLabel.setAttribute('aria-label', '來源與略過・' + row.label);
    extra.append(menuLabel);
    extra.addEventListener('toggle', () => requestAnimationFrame(layout));
    const skip = button('略過此欄', () => {
      row.skipped = !row.skipped;
      row.flagged = false;
      reviewDirty = true;
      update();
    });
    extra.append(skip);
    const candidates = [];
    const uncertain = !row.initial && row.regions.filter((region) => region.value && !/上下文|範圍/.test(region.value));
    if (uncertain)
      for (const region of uncertain) {
        let value = region.value.replace(/%$/, '');
        if (row.code && value.startsWith(row.code + ' ')) value = value.slice(3);
        if (valueError(row.code ? 'taiwan' : row.key, value)) continue;
        const adopt = button('採用截圖 ' + ((region.image || 0) + 1) + ' 的 ' + value, () => {
          row.value = value;
          row.override = true;
          row.skipped = false;
          reviewDirty = true;
          update();
        });
        candidates.push(adopt);
        extra.append(
          adopt,
          button('查看這個來源', (event) => openOriginal(region.image || 0, region, event.currentTarget)),
        );
      }
    if (uncertain?.length) {
      extra.open = true;
      extra.classList.add('has-candidates');
    }
    let select;
    if (row.group === 1) {
      const field = text('label', '', 'ocr-map-country-select');
      select = document.createElement('select');
      select.setAttribute('aria-label', row.label + '的國家名稱');
      select.append(text('option', '選擇國家名稱'));
      select.options[0].value = '';
      for (const code of screenshotSelectableCountryCodes) {
        const option = text('option', countryName(code) + ' · ' + code);
        option.value = code;
        select.append(option);
      }
      select.value = row.code;
      select.addEventListener('change', () => {
        row.code = select.value;
        row.label = row.code === 'TW' ? '台灣占比' : row.code ? countryName(row.code) : '待辨識國家';
        row.key = row.code === 'TW' ? 'taiwan' : 'countries';
        row.override = true;
        label.textContent = row.label;
        input.setAttribute('aria-label', '核對' + row.label);
        reviewDirty = true;
        const duplicate = countryRows().find((entry) => entry !== row && entry.code === row.code && !entry.value && !entry.override);
        if (duplicate) {
          rows.splice(rows.indexOf(duplicate), 1);
          buildPanels();
          renderPanel();
          locate(row);
        } else update();
      });
      field.append(text('span', '原圖中的國家'), select);
      if (row.code) extra.append(field);
      else card.append(field);
    }
    card.append(head, line, note, extra);
    const region = row.regions.find((r) => r.image === panel.image);
    if (region)
      loadPicture(panel.image)
        .then((picture) => {
          if (!card.isConnected) return;
          const bounds = region.valueBox || region;
          const x = Math.max(0, bounds.x - 12),
            y = Math.max(0, bounds.y - 10);
          const w = Math.min(images[panel.image].width - x, bounds.w + 24),
            h = Math.min(images[panel.image].height - y, bounds.h + 20);
          crop.width = Math.round(w * 2);
          crop.height = Math.round(h * 2);
          crop
            .getContext('2d')
            .drawImage(
              picture,
              (x / images[panel.image].width) * picture.naturalWidth,
              (y / images[panel.image].height) * picture.naturalHeight,
              (w / images[panel.image].width) * picture.naturalWidth,
              (h / images[panel.image].height) * picture.naturalHeight,
              0,
              0,
              crop.width,
              crop.height,
            );
          crop.hidden = false;
        })
        .catch(() => {
          note.textContent = '原圖載入失敗，請重新選取截圖。';
        });
    row.controls.push({ card, input, flag, note, skip, select, candidates });
    return card;
  }
  let stage, picture, rail, connectors, geometry, layoutObserver;
  function renderPanel() {
    layoutObserver?.disconnect();
    for (const row of rows) row.controls = [];
    for (const [index, tab] of [...nav.children].entries()) tab.setAttribute('aria-pressed', String(index === activePanel));
    const panel = panels[activePanel];
    const regions = panel.rows.flatMap((row) => row.regions.filter((region) => region.image === panel.image));
    const source = images[panel.image];
    const x = Math.max(0, Math.min(...regions.map((region) => region.x), 0));
    const top = Math.max(0, Math.min(...regions.map((region) => region.y)) - 70);
    const bottom = Math.min(source.height, Math.max(...regions.map((region) => region.y + region.h)) + 60);
    const left = panel.group === 3 && regions.length ? Math.max(0, Math.min(...regions.map((r) => r.x)) - 35) : x;
    geometry = {
      x: left,
      y: Number.isFinite(top) ? top : 0,
      w: source.width - left,
      h: Number.isFinite(bottom - top) && bottom > top ? bottom - top : source.height,
    };
    const labels = text('div', '', 'ocr-map-column-labels');
    labels.append(text('span', '原始截圖 · 保留原圖位置'), text('span', '辨識結果 · 直接修改'));
    stage = text('div', '', 'ocr-map-stage');
    picture = document.createElement('canvas');
    picture.className = 'ocr-map-picture';
    picture.width = Math.round(geometry.w);
    picture.height = Math.round(geometry.h);
    picture.setAttribute('role', 'img');
    picture.setAttribute('aria-label', panel.label + '的原始截圖');
    const canvas = picture,
      bounds = { ...geometry };
    loadPicture(panel.image)
      .then((original) => {
        if (!canvas.isConnected) return;
        canvas
          .getContext('2d')
          .drawImage(
            original,
            (bounds.x / source.width) * original.naturalWidth,
            (bounds.y / source.height) * original.naturalHeight,
            (bounds.w / source.width) * original.naturalWidth,
            (bounds.h / source.height) * original.naturalHeight,
            0,
            0,
            canvas.width,
            canvas.height,
          );
      })
      .catch(() => {
        setStatus('原圖載入失敗，請重新選取截圖。', true);
      });
    rail = text('div', '', 'ocr-map-rail');
    for (const row of panel.rows) rail.append(makeControl(row, panel));
    connectors = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    connectors.classList.add('ocr-map-connectors');
    connectors.setAttribute('aria-hidden', 'true');
    stage.append(picture, connectors, rail);
    board.replaceChildren(labels, stage);
    layoutObserver = new ResizeObserver(() => {
      if (!review.contains(board)) layoutObserver.disconnect();
      else layout();
    });
    layoutObserver.observe(board);
    layoutObserver.observe(rail);
    update();
  }
  function layout() {
    if (!stage?.isConnected || matchMedia('(max-width: 760px)').matches) {
      if (stage) stage.style.height = '';
      return;
    }
    const panel = panels[activePanel];
    const scale = picture.clientWidth / geometry.w;
    let bottom = 0;
    for (const row of panel.rows) {
      const control = row.controls[0];
      const region = row.regions.find((r) => r.image === panel.image);
      const desired = region ? (region.y + region.h / 2 - geometry.y) * scale - control.card.offsetHeight / 2 : bottom;
      const top = Math.max(8, desired, bottom);
      control.card.style.top = top + 'px';
      bottom = top + control.card.offsetHeight + 10;
    }
    const height = Math.max(picture.clientHeight, bottom);
    stage.style.height = height + 'px';
    connectors.setAttribute('viewBox', '0 0 ' + stage.clientWidth + ' ' + height);
    connectors.replaceChildren();
    for (const row of panel.rows) {
      const region = row.regions.find((r) => r.image === panel.image);
      if (!region) continue;
      const bounds = region.valueBox || region;
      const x = (bounds.x - geometry.x) * scale,
        y = (bounds.y - geometry.y) * scale;
      const w = bounds.w * scale,
        h = bounds.h * scale;
      const rect = document.createElementNS(connectors.namespaceURI, 'rect');
      for (const [key, value] of Object.entries({ x: x - 4, y: y - 4, width: w + 8, height: h + 8, rx: 4 })) rect.setAttribute(key, value);
      const line = document.createElementNS(connectors.namespaceURI, 'path');
      const control = row.controls[0];
      line.setAttribute(
        'd',
        'M ' + (x + w + 5) + ' ' + (y + h / 2) + ' L ' + rail.offsetLeft + ' ' + (control.card.offsetTop + control.card.offsetHeight / 2),
      );
      connectors.append(rect, line);
    }
  }
  function applyValues() {
    if (applied) return;
    if (staleFields().length) {
      update();
      refresh.focus();
      return;
    }
    const values = prospective();
    const issues = problems(values);
    if (issues.length) {
      issues[0].row ? locate(issues[0].row) : footer.scrollIntoView({ block: 'center' });
      return;
    }
    const changed = changedFields(values);
    const previousMonth = month.value;
    if (month.value !== targetMonth) {
      month.value = targetMonth;
      month.dispatchEvent(new Event('change', { bubbles: true }));
    }
    clearFormSources();
    for (const key of changed) {
      const field = form.elements.namedItem(key);
      field.value = values[key];
      field.dataset.ocrFilled = 'true';
    }
    if (changed.some((key) => key.startsWith('desktop_'))) form.querySelector('[data-desktop-channels]').open = true;
    form.dispatchEvent(new Event('input', { bubbles: true }));
    applied = true;
    reviewDirty = false;
    updateSaveHandoff(false);
    partialLabel.hidden = true;
    scope.hidden = true;
    recovery.hidden = true;
    const sourcesApplied = [];
    for (const key of changed) {
      const field = form.elements.namedItem(key);
      const row = rows.find((entry) => (key === 'countries' ? entry.group === 1 : entry.key === key));
      if (!row) continue;
      const backlink = button(screenshotFields[key] + ' · 回到原圖核對 ↖', () => {
        locate(row);
      });
      backlink.className = 'ocr-form-source';
      field.closest('.field').append(backlink);
      sourcesApplied.push({ field, backlink, value: field.value });
    }
    if (reviewFormChange) form.removeEventListener('input', reviewFormChange);
    reviewFormChange = () => {
      for (const { field, backlink, value } of sourcesApplied) {
        const edited = !sameValue(field.name, field.value, value);
        if (edited || month.value !== targetMonth) delete field.dataset.ocrFilled;
        backlink.textContent = screenshotFields[field.name] + (edited ? ' · 已修改表單，查看原辨識值 ↖' : ' · 回到原圖核對 ↖');
      }
      update();
    };
    form.addEventListener('input', reviewFormChange);
    setStatus(
      changed.length
        ? '已填入 ' +
            changed.length +
            ' 個欄位，尚未儲存。' +
            (rows.some((row) => row.skipped)
              ? ' 已略過：' +
                rows
                  .filter((row) => row.skipped)
                  .map((row) => row.label)
                  .join('、') +
                '。'
              : '') +
            (partial.checked ? ' 國家列表僅填入已讀部分。' : '') +
            (previousMonth !== targetMonth ? ' 已切換至 ' + targetLabel + '，原月份草稿保留。' : '')
        : '核對完成，數值與表單相同；表單內容未更動。',
    );
    setStep('save');
    update();
    handoff.focus();
  }
  if (result.countryTable) {
    const raw = document.createElement('textarea');
    raw.hidden = true;
    const helper = createCountryHelper(() => raw);
    const prepare = () => {
      raw.value = countryRows()
        .filter((row) => row.code && row.value)
        .map((row) => row.code + ' ' + row.value)
        .join('\n');
    };
    helper.element.addEventListener('focusin', prepare);
    raw.addEventListener('input', () => {
      for (const line of raw.value.split('\n').filter(Boolean)) {
        const [code, value] = line.split(/\s+/);
        let row = countryRows().find((entry) => entry.code === code);
        if (!row) row = countryRows().find((entry) => !entry.code && entry.value === value);
        if (!row) row = addRow(code === 'TW' ? 'taiwan' : 'countries', '', [], code);
        row.code = code;
        row.label = code === 'TW' ? '台灣占比' : countryName(code);
        row.key = code === 'TW' ? 'taiwan' : 'countries';
        row.value = value;
        row.override = true;
        row.skipped = false;
      }
      reviewDirty = true;
      buildPanels();
      renderPanel();
    });
    recovery.append(raw, helper.element);
  }
  if (reviewFormChange) form.removeEventListener('input', reviewFormChange);
  reviewFormChange = () => update();
  form.addEventListener('input', reviewFormChange);
  if (reviewMonthChange) month.removeEventListener('change', reviewMonthChange);
  reviewMonthChange = () => update();
  month.addEventListener('change', reviewMonthChange);
  updateSaveHandoff(true);
  uploadTarget.textContent = '核對對象：' + host.dataset.domain + ' · ' + targetLabel;
  buildPanels();
  // Start at the first source, with every value visible; no per-field acknowledgement.
  renderPanel();
  recognize.textContent = '重新辨識';
  recognize.classList.remove('primary');
  setStep('review');
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
            for (const country of result.unmatchedCountries || []) country.image = i;
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
