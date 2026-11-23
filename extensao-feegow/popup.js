const fileInput = document.querySelector('#file');
const drop = document.querySelector('#drop');
const status = document.querySelector('#status');
const login = document.querySelector('#login');
const output = document.querySelector('#result');
const summary = document.querySelector('#summary');
let processing = false;
let currentFile;
let savedPdf;
const fileLabel = document.querySelector('#lab-filename');
function restoreLab(data) {
  if (data.labFile) {
    savedPdf = data.labFile;
    fileLabel.textContent = data.labFile.name;
  }
  if (data.labResult) showLabResult(data.labResult);
}
chrome.storage.session.get(['labFile','labResult']).then(data=>{if(!processing)restoreLab(data);});
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==='session' && changes.labResult?.newValue && !processing)showLabResult(changes.labResult.newValue);
});
const recipeInput = document.querySelector('#recipe-file');
const recipeButton = document.querySelector('#recipe-download');
recipeInput.onchange = () => {
  const file = recipeInput.files[0];
  recipeInput.value = '';
  if (file) downloadRecipe(file);
};
recipeButton.onclick = () => {
  if (!processing) {
    if (currentFile?.type === 'application/pdf') downloadRecipe(currentFile);
    else if(savedPdf?.mime==='application/pdf')downloadRecipe(savedPdf);
    else recipeInput.click();
  }
};

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
  currentFile = file;
  processing = recipeButton.disabled = true;
  login.hidden = true;
  output.hidden = true;
  status.textContent = 'Processando o laudo…';
  try {
    const encoded = await encodeFile(file);
    const record={name:file.name,mime:file.type,encoded,size:file.size};
    await chrome.storage.session.set({labFile:record,labResult:{status:'processing'}});
    savedPdf=record;
    fileLabel.textContent=file.name;
    const result = await chrome.runtime.sendMessage({ type: 'eclaire.uploadLab', file: encoded, mime: file.type });
    showLabResult(result);
  } catch {
    status.textContent = 'Falha ao processar o laudo. Tente novamente.';
  } finally {
    processing = recipeButton.disabled = false;
  }
}

function showLabResult(result) {
    const messages = {
      processing:'Processando o laudo…',
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

function encodeFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function downloadRecipe(file) {
  if (processing) return;
  if ((file.type||file.mime) !== 'application/pdf' || !file.size || file.size > 5 * 1024 * 1024) {
    status.textContent = 'Selecione um PDF de até 5 MB para gerar a receita.';
    return;
  }
  if(!file.encoded)currentFile = file;
  processing = recipeButton.disabled = true;
  login.hidden = true;
  status.textContent = 'Preparando a receita em Word…';
  const origin = 'https://sistema-eclaire-clinico.onrender.com';
  try {
    if(!file.encoded){
      savedPdf={name:file.name,mime:file.type,encoded:await encodeFile(file),size:file.size};
      await chrome.storage.session.set({labFile:savedPdf,labResult:null});
      fileLabel.textContent=file.name;
    }
    const template = await fetch(origin + '/api/prescription-template', { credentials: 'include' });
    if (template.status === 401) {
      login.hidden = false;
      throw Error('Entre no Éclairé e tente novamente pelo pop-up.');
    }
    if (!template.ok) throw Error('O modelo Word precisa estar configurado no servidor do Éclairé.');
    const response = await fetch(origin + '/api/documents', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf: file.encoded || savedPdf.encoded, notes: '' })
    });
    if (response.status === 401) {
      login.hidden = false;
      throw Error('Entre no Éclairé e tente novamente pelo pop-up.');
    }
    const result = await response.json();
    if (!response.ok) throw Error(result.error);
    const content = result.prescription;
    const patient = content?.replace(/\\r\\n|\\n/g, '\n').split(/\r?\n/)
      .map(line => line.replace(/\*\*/g, '').replace(/^\s*#{1,6}\s+/, '').match(/^\s*PARA(?:\s*:\s*|\s+)(.+?)\s*$/iu)?.[1])
      .find(Boolean);
    const filename = patient?.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!filename) throw Error('Não foi possível identificar a receita retornada.');
    const docx = await fillOriginalRecipe(await template.blob(), patient, content, new Date().toLocaleDateString('pt-BR'));
    const url = URL.createObjectURL(docx);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename + ' - receita.docx';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = 'Download da receita iniciado.';
  } catch (error) {
    status.textContent = error.message || 'Não foi possível baixar a receita.';
  } finally {
    processing = recipeButton.disabled = false;
  }
}
