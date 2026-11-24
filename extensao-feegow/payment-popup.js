const paymentOrigin = 'https://minhaconta.saudeservice.evoluservices.com';
const paymentForm = document.querySelector('#payment-form');
const paymentStatus = document.querySelector('#payment-status');
function showPayment(result) {
  paymentStatus.textContent = result.message;
  if (result.url) showPaymentLink(result.url);
}
function showPaymentLink(url) {
  const link = document.querySelector('#payment-link');
  link.href = url;
  link.textContent = url;
  document.querySelector('#payment-result').hidden = false;
}
async function copyPayment(url) {
  try { await navigator.clipboard.writeText(url); paymentStatus.textContent = 'Link copiado.'; }
  catch { paymentStatus.textContent = 'Pronto. Abra o link ou clique em Copiar.'; }
}
const draft = () => ({patient:paymentForm.elements.patient.value, amount:paymentForm.elements.amount.value});
paymentForm.addEventListener('input', () => chrome.storage.session.set({paymentDraft:draft()}));
chrome.storage.session.get(['paymentResult','paymentDraft','lastPaymentLink']).then(({paymentResult,paymentDraft,lastPaymentLink}) => {
  if (lastPaymentLink) showPaymentLink(lastPaymentLink);
  if (paymentResult) showPayment(paymentResult);
  if (paymentDraft && !draft().patient && !draft().amount) {
    paymentForm.elements.patient.value = paymentDraft.patient;
    paymentForm.elements.amount.value = paymentDraft.amount;
  }
});
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==='session' && changes.paymentResult?.newValue)showPayment(changes.paymentResult.newValue);
});
document.querySelector('#payment-copy').onclick = () => copyPayment(document.querySelector('#payment-link').href);
paymentForm.onsubmit = async event => {
  event.preventDefault();
  const patient = paymentForm.elements.patient.value.trim();
  const amount = Number(paymentForm.elements.amount.value);
  if (!patient || !Number.isSafeInteger(Math.round(amount * 100)) || amount < 0.01) {
    showPayment({message:'Informe o nome e um valor maior que zero.'});
    return;
  }
  const button = paymentForm.querySelector('button');
  button.disabled = true;
  showPayment({message:'Abrindo o Saúde Service…'});
  try {
    if (!await chrome.permissions.request({origins:[paymentOrigin + '/*']})) {
      showPayment({message:'O Chrome precisa da sua autorização inicial para abrir o Saúde Service.'});
      return;
    }
    const result = await chrome.runtime.sendMessage({type:'eclaire.paymentLink', patient, cents:Math.round(amount * 100)});
    showPayment(result);
    if(result.url) await copyPayment(result.url);
  } catch {
    showPayment({message:'Reabra o pop-up para consultar o andamento.'});
  } finally { button.disabled = false; }
};
