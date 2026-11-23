const paymentOrigin = 'https://minhaconta.saudeservice.evoluservices.com';
const paymentForm = document.querySelector('#payment-form');
const paymentStatus = document.querySelector('#payment-status');
function showPayment(result) {
  paymentStatus.textContent = result.message;
  const link = document.querySelector('#payment-link');
  link.href = result.url || '#';
  link.textContent = result.url || '';
  document.querySelector('#payment-result').hidden = !result.url;
}
async function copyPayment(url) {
  try { await navigator.clipboard.writeText(url); paymentStatus.textContent = 'Link copiado.'; }
  catch { paymentStatus.textContent = 'Pronto. Abra o link ou clique em Copiar.'; }
}
chrome.storage.session.get('paymentResult').then(({paymentResult}) => { if (paymentResult) showPayment(paymentResult); });
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
  showPayment({message:'Verificando conta…'});
  try {
    if (!await chrome.permissions.request({origins:[paymentOrigin + '/*']})) {
      showPayment({message:'Autorize o acesso ao Saúde Service para gerar o link.'});
      return;
    }
    const result = await chrome.runtime.sendMessage({type:'eclaire.paymentLink', patient, cents:Math.round(amount * 100)});
    showPayment(result);
    if(result.url) await copyPayment(result.url);
  } catch {
    showPayment({message:'Reabra o pop-up para consultar o andamento.'});
  } finally { button.disabled = false; }
};
