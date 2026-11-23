const eclaireOrigin = 'https://sistema-eclaire-clinico.onrender.com';
const feegowPattern = 'https://app.feegow.com/main/*';

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

async function prepareSearch(patientName) {
  const tabs = await chrome.tabs.query({ url: feegowPattern, currentWindow: true });
  const home = tabs.filter(tab => new URL(tab.url).searchParams.get('P')?.toLowerCase() === 'home');
  const candidates = home.length ? home : tabs;
  if (candidates.length !== 1) return { status: candidates.length ? 'multipleTabs' : 'noTab' };
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: candidates[0].id },
    func: fillQuickSearch,
    args: [patientName]
  });
  if (!result) return { status: 'noSearch' };
  await chrome.tabs.update(candidates[0].id, { active: true });
  return { status: 'ready' };
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (sender.origin !== eclaireOrigin || sender.frameId !== 0 ||
      message?.type !== 'eclaire.feegow.prepareLabSummary' || message.version !== 1) return;
  const name = typeof message.patientName === 'string' ? message.patientName.trim() : '';
  if (!name || name.length > 160 || /[\u0000-\u001f\u007f]/.test(name)) {
    sendResponse({ status: 'invalidName' });
    return;
  }
  prepareSearch(name).then(sendResponse, () => sendResponse({ status: 'error' }));
  return true;
});
