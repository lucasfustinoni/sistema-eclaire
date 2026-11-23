const fileInput = document.querySelector('#file');
const drop = document.querySelector('#drop');
const status = document.querySelector('#status');
const login = document.querySelector('#login');
const output = document.querySelector('#result');
const summary = document.querySelector('#summary');
let processing = false;

fileInput.addEventListener('change', () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  upload(files);
});
drop.addEventListener('dragover', event => {
  event.preventDefault();
  drop.dataset.over = '';
});
drop.addEventListener('dragleave', () => delete drop.dataset.over);
drop.addEventListener('drop', event => {
  event.preventDefault();
  delete drop.dataset.over;
  upload([...event.dataTransfer.files]);
});

async function upload(files) {
  if (processing) return;
  const [file] = files;
  if (files.length !== 1 || !file.size || file.size > 5 * 1024 * 1024 ||
      !['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    status.textContent = 'Selecione um laudo em PDF, JPG, PNG ou WebP de até 5 MB.';
    return;
  }
  processing = true;
  login.hidden = true;
  output.hidden = true;
  status.textContent = 'Processando o laudo…';
  try {
    const encoded = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const result = await chrome.runtime.sendMessage({ type: 'eclaire.uploadLab', file: encoded, mime: file.type });
    const messages = {
      signIn: 'Entre no Éclairé e envie o laudo novamente pelo ícone.',
      incomplete: 'Confira se o laudo contém o nome do paciente e resultados legíveis.',
      drafted: 'Resumo inserido para revisão e salvamento no Feegow.',
      ready: 'Confira o resultado da busca no Feegow.',
      busy: 'Aguarde a operação anterior terminar.',
      loginRequired: 'Conclua o login na aba do Feegow.',
      multipleTabs: 'Deixe apenas uma aba do Feegow aberta e tente novamente.',
      noMagnifier: 'A evolução precisa ser aberta manualmente no Feegow.',
      noEditor: 'O editor de evolução não foi localizado.'
    };
    status.textContent = result.error || messages[result.status] || 'Não foi possível concluir o envio ao Feegow.';
    login.hidden = result.status !== 'signIn';
    if (result.summary) {
      document.querySelector('#patient').textContent = result.patientName || '';
      summary.value = result.summary;
      output.hidden = false;
    }
  } catch {
    status.textContent = 'Falha ao processar o laudo. Tente novamente.';
  } finally {
    processing = false;
  }
}

document.querySelector('#copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(summary.value);
    status.textContent = 'Resumo copiado.';
  } catch {
    summary.select();
    status.textContent = 'Resumo selecionado. Use Ctrl+C ou ⌘C.';
  }
});
