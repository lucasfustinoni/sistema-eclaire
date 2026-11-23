const eclaireOrigin = 'https://sistema-eclaire-clinico.onrender.com';
const feegowPatterns = ['https://clinic.feegow.com/*', 'https://app.feegow.com/*'];

function fillQuickSearch(patientName) {
  function isQuickSearch(input) {
    return ['placeholder', 'aria-label', 'title'].some(attribute =>
      /^busca rápida(?:\.{3}|…)?$/i.test(input.getAttribute(attribute)?.trim() || '')
    );
  }
  const fields = Array.from(document.querySelectorAll('input')).filter(input =>
    ['text', 'search'].includes(input.type) && !input.disabled && !input.readOnly &&
    input.getClientRects().length > 0 && getComputedStyle(input).visibility === 'visible' &&
    isQuickSearch(input)
  );
  if (fields.length !== 1) return false;
  const field = fields[0];
  field.click();
  field.focus();
  if (!field.isConnected) return false;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, patientName);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  return field.value === patientName;
}

function inspectResults(patientName) {
  const normalize = value => value.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('pt-BR');
  if (new URL(location.href).searchParams.get('P')?.toLowerCase() !== 'busca' ||
      normalize(new URL(location.href).searchParams.get('q') || '') !== normalize(patientName)) return null;

  const links = [...document.querySelectorAll('a[href]')].flatMap(link => {
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || url.pathname !== '/main/' ||
        url.searchParams.get('P')?.toLowerCase() !== 'pacientes' ||
        !/^\d+$/.test(url.searchParams.get('I') || '') ||
        !link.closest('tr') || !link.getClientRects().length || !link.innerText.trim()) return [];
    return [{ link, url, matches: normalize(link.innerText) === normalize(patientName) }];
  });
  const ids = new Set(links.map(item => item.url.searchParams.get('I')));
  const exact = links.filter(item => item.matches);
  const exactIds = new Set(exact.map(item => item.url.searchParams.get('I')));
  if (exactIds.size === 1) {
    const { link, url } = exact[0];
    setTimeout(() => link.click(), 0);
    return { status: 'exact', destination: url.href };
  }
  if (ids.size) return { status: 'review' };
  if (/nenhum (?:paciente|resultado|registro)|não (?:foi encontrado|foram encontrados)/i.test(document.body.innerText)) {
    return { status: 'empty' };
  }
  return null;
}

async function runInTab(tabId, func, args = []) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result;
}

async function waitForPage(tabId, predicate) {
  for (let attempt = 0; attempt < 24; attempt++) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && tab.url) {
      const result = await predicate(new URL(tab.url));
      if (result) return result;
    }
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  return null;
}

function showReview(message) {
  setTimeout(() => alert(message), 0);
}

function editEvolution(patientId, step, entry) {
  const url = new URL(location.href);
  if (url.searchParams.get('P')?.toLowerCase() !== 'pacientes' ||
      url.searchParams.get('I') !== patientId) return false;
  const visible = element => element?.getClientRects().length && getComputedStyle(element).visibility === 'visible';
  if (step === 'section') {
    const section = document.querySelector('#abaForms[href="#forms"]');
    if (!visible(section)) return false;
    if (section.getAttribute('aria-expanded') !== 'true') section.click();
    return true;
  }
  if (step === 'open') {
    if (visible(document.querySelector('#input_50mem[contenteditable="true"]'))) return true;
    const links = [...document.querySelectorAll('a:has(i.fa-search-plus)')].filter(visible);
    if (links.length !== 1) return false;
    links[0].click();
    return true;
  }
  const editor = document.querySelector('#input_50mem[contenteditable="true"]');
  if (!visible(editor)) return false;
  const existing = editor.innerText.trimEnd();
  if (existing.endsWith(entry)) return true;
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return document.execCommand('insertText', false, (existing ? '\n' : '') + entry);
}

async function prepareEvolution(tabId, patientId, summary, urlMatches) {
  for (const step of ['section', 'open', 'append']) {
    const entry = step === 'append'
      ? new Intl.DateTimeFormat('pt-BR', {day:'2-digit',month:'2-digit',year:'2-digit'}).format(new Date()).replaceAll('/', '-') + '\n' + summary
      : '';
    const finished = await waitForPage(tabId, url =>
      urlMatches(url) && runInTab(tabId, editEvolution, [patientId, step, entry]));
    if (!finished) return { status: 'noEditor' };
  }
  return { status: 'drafted' };
}

async function searchAndReview(tab, patientName, summary) {
  const original = new URL(tab.url);
  if (original.hostname !== 'clinic.feegow.com') return { status: 'ready' };
  // Use the same results URL as submitting the native quick-search box with Enter.
  const search = new URL('/main/', original.origin);
  search.search = new URLSearchParams({ q: patientName, P: 'Busca', Pers: original.searchParams.get('Pers') || '1' });
  await chrome.tabs.update(tab.id, { url: search.href });
  const outcome = await waitForPage(tab.id, url => {
    if (url.origin !== search.origin || url.pathname !== search.pathname ||
        url.searchParams.get('P') !== 'Busca') return null;
    return runInTab(tab.id, inspectResults, [patientName]);
  });
  if (outcome?.status === 'exact') {
    const destination = new URL(outcome.destination);
    const urlMatches = url =>
      url.origin === destination.origin && url.pathname === destination.pathname &&
      url.searchParams.get('P')?.toLowerCase() === 'pacientes' &&
      url.searchParams.get('I') === destination.searchParams.get('I');
    if (!await waitForPage(tab.id, urlMatches)) return { status: 'error' };
    if (!summary) return { status: 'ready' };
    return prepareEvolution(tab.id, destination.searchParams.get('I'), summary, urlMatches);
  }
  const loaded = await chrome.tabs.get(tab.id);
  if (loaded.url && new URL(loaded.url).origin === search.origin) {
    const message = outcome?.status === 'empty'
      ? 'Nenhum paciente foi encontrado. Confira o nome e revise a busca manualmente.'
      : 'A busca não confirmou um único nome idêntico. Confira os resultados e selecione o paciente manualmente.';
    await runInTab(tab.id, showReview, [message]);
    return { status: 'ready' };
  }
  return { status: 'error' };
}

async function prepareSearch(patientName, summary) {
  const tabs = await chrome.tabs.query({ url: feegowPatterns });
  const pages = tabs.filter(tab => tab.url && ['/', '/main', '/main/'].includes(new URL(tab.url).pathname));
  const clinic = pages.filter(tab => new URL(tab.url).hostname === 'clinic.feegow.com');
  const matchingTabs = clinic.length ? clinic : pages;
  const home = matchingTabs.filter(tab => {
    const url = new URL(tab.url);
    return url.searchParams.get('P')?.toLowerCase() === 'home' || (url.pathname === '/' && !url.searchParams.has('P'));
  });
  const candidates = home.length ? home : matchingTabs;
  if (candidates.length !== 1) return { status: candidates.length ? 'multipleTabs' : 'noTab' };
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: candidates[0].id },
    func: fillQuickSearch,
    args: [patientName]
  });
  if (!result) return { status: 'noSearch' };
  await chrome.tabs.update(candidates[0].id, { active: true });
  await chrome.windows.update(candidates[0].windowId, { focused: true });
  return searchAndReview(candidates[0], patientName, summary);
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (sender.origin !== eclaireOrigin || sender.frameId !== 0 ||
      message?.type !== 'eclaire.feegow.prepareLabSummary' || message.version !== 1) return;
  const name = typeof message.patientName === 'string' ? message.patientName.trim() : '';
  if (!name || name.length > 160 || /[\u0000-\u001f\u007f]/.test(name)) {
    sendResponse({ status: 'invalidName' });
    return;
  }
  const summary = typeof message.summary === 'string' ? message.summary.trim() : '';
  if (summary.length > 12000 || /[\r\n]/.test(summary)) {
    sendResponse({ status: 'invalidSummary' });
    return;
  }
  prepareSearch(name, summary).then(sendResponse, () => sendResponse({ status: 'error' }));
  return true;
});
