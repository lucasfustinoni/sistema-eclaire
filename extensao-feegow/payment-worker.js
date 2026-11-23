(() => {
  const origin = 'https://minhaconta.saudeservice.evoluservices.com';
  let running = false;

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.url !== chrome.runtime.getURL('popup.html') || message?.type !== 'eclaire.paymentLink') return;
    const patient = typeof message.patient === 'string' ? message.patient.trim() : '';
    const cents = message.cents;
    if (!patient || patient.length > 120 || !Number.isSafeInteger(cents) || cents <= 0) {
      respond({ message: 'Informe um nome e valor válidos.' });
      return;
    }
    if (running) { respond({ message: 'Já existe uma geração em andamento.' }); return; }
    running = true;
    generate(patient, cents).then(respond, async error => {
      const result = { message: error.message || 'Não foi possível gerar o link.' };
      await chrome.storage.session.set({paymentResult:result});
      respond(result);
    }).finally(() => { running = false; });
    return true;
  });

  async function generate(patient, cents) {
    const hostPattern = origin + '/*';
    if (!await chrome.permissions.contains({origins:[hostPattern]})) {
      throw Error('Autorize o acesso ao Saúde Service pelo pop-up.');
    }
    await chrome.storage.session.set({paymentResult:{message:'Abrindo o Saúde Service…'}});
    const tabs = await chrome.tabs.query({url:hostPattern});
    const existing = tabs.find(tab => /^\/venda\/?$/.test(new URL(tab.url).pathname));
    let tab = existing;
    if (existing?.status === 'complete') {
      const [{result: dialogOpen}] = await chrome.scripting.executeScript({
        target:{tabId:existing.id},
        func:() => [...document.querySelectorAll('[role=dialog],[aria-modal=true],dialog[open],.MuiDialog-paper')]
          .some(el => el.getClientRects().length && /enviar link de pagamento|seu link foi gerado/i.test(el.innerText))
      });
      if (dialogOpen) tab = null;
    }
    tab ||= await chrome.tabs.create({url:origin + '/venda', active:false});
    const deadline = Date.now() + 10000;
    let result;
    do {
      const current = await chrome.tabs.get(tab.id);
      if (current.url && !current.url.startsWith(origin + '/') && current.status === 'complete') throw Error('Faça login primeiro no Saúde Service.');
      if (current.url?.startsWith(origin + '/') && current.status === 'complete') {
        try {
          const [{result: pageResult}] = await chrome.scripting.executeScript({
            target:{tabId:tab.id}, func: runSale, args:[patient,cents]
          });
          result = pageResult;
          break;
        } catch {
          const latest = await chrome.tabs.get(tab.id);
          if (!latest.url?.startsWith(origin + '/')) throw Error('Faça login primeiro no Saúde Service.');
          throw Error('A aba de venda mudou durante a operação. Confira o portal antes de tentar novamente.');
        }
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    if (!result) throw Error('A página de venda não ficou disponível. Faça login primeiro.');
    await chrome.storage.session.set(result.url ? {paymentResult:result,lastPaymentLink:result.url} : {paymentResult:result});
    return result;
  }

  async function runSale(patient, cents) {
    const normalize = value => value.normalize('NFD').replace(/\p{M}/gu,'').replace(/\s+/g,' ').trim().toLowerCase();
    const visible = element => element?.getClientRects().length && getComputedStyle(element).visibility === 'visible';
    const text = element => normalize(element.innerText || element.getAttribute('aria-label') || element.title || '');
    const buttons = () => [...document.querySelectorAll('button,[role=button],a')].filter(visible);
    const find = (labels, root=document) => buttons().find(element => root.contains(element) && labels.some(label => text(element) === normalize(label)) && !element.disabled && element.getAttribute('aria-disabled') !== 'true');
    const wait = async (step, locate, ms=10000) => {
      const until = Date.now() + ms;
      do {
        const result = locate();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 180));
      } while(Date.now() < until);
      throw Error(step);
    };
    const click = async (step, labels, root=document) => (await wait(step, () => find(labels, root))).click();
    const set = (field,value) => {
      const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(field,value);
      for (const type of ['input','change']) field.dispatchEvent(new Event(type,{bubbles:true}));
    };
    const field = (label, root=document) => {
      const expected = normalize(label);
      return [...root.querySelectorAll('input,textarea')].filter(visible).find(input =>
        [input.placeholder||'',input.getAttribute('aria-label')||'',...[...(input.labels||[])].map(item=>item.innerText||'')].some(name=>normalize(name).replace(/\s*[*:]$/,'')===expected));
    };
    const dialogs = () => [...document.querySelectorAll('[role=dialog],[aria-modal=true],dialog[open],.MuiDialog-paper')].filter(visible);
    const money = new Intl.NumberFormat('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}).format(cents/100);
    try {
      if (location.origin !== 'https://minhaconta.saudeservice.evoluservices.com' || !/^\/venda\/?$/.test(location.pathname)) throw Error('Abra a página Nova Venda e faça login primeiro.');
      if (normalize(document.body.innerText).includes('sua conta mais segura')) {
        await click('Conclua a tela de segurança para continuar.', ['Ativar depois','Enable later']);
      }
      const profile = await wait('Não encontrei o menu de perfil.',()=>buttons().find(x=>/^(perfil|meu perfil|minha conta|menu do usuario|user menu|profile|eclaire servicos medicos ltda)$/.test(text(x)) ||
        /perfil|avatar|account|profile/.test(normalize([x.getAttribute('aria-label'),x.title,x.getAttribute('data-testid')].filter(Boolean).join(' ')))) || [...document.querySelectorAll('header button.MuiIconButton-root')].filter(visible).at(-1));
      profile.click();
      const accountMenu = await wait('Não consegui conferir os dados da conta ativa.',()=>[...document.querySelectorAll('[role=menu],[role=dialog], [data-state=open], [data-popper-placement]')].filter(visible).find(x=>normalize(x.innerText||'').includes('@')));
      const accountText = normalize(accountMenu.innerText);
      const menuItems = [...accountMenu.querySelectorAll('[role=menuitem]')].filter(visible);
      if (menuItems.length !== 4 || !accountText.includes('clinicaeclaire@gmail.com') || !text(menuItems[1]).includes('eclaire servicos medicos ltda')) throw Error('Conta incorreta ou não foi possível confirmar a conta ativa.');
      accountMenu.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      await wait('Feche o menu do perfil para continuar.',()=>!visible(accountMenu));
      set(await wait('Não encontrei Valor do Tratamento.',()=>field('Valor do Tratamento')),money);
      await click('Não encontrei Calcular.', ['Calcular']);
      await click('Não encontrei Link de Pagamento.', ['Link de Pagamento']);
      for(let index=0;index<5;index++){
        const news = dialogs().find(el=>normalize(el.innerText).includes('temos novidade'));
        if(!news) break;
        const previous = news.innerText;
        await click('Não consegui fechar o aviso de novidades.', ['Avançar','Fechar','×','X'],news);
        await wait('O aviso de novidades não avançou.',()=>!visible(news)||!normalize(news.innerText).includes('temos novidade')||news.innerText!==previous);
      }
      const avulsa = await wait('Não encontrei o título Avulsa no portal.', () => {
        const headings = [...document.querySelectorAll('h6')].filter(el =>
          visible(el) && normalize(el.textContent) === 'avulsa');
        return headings.length === 1 ? headings[0] : null;
      });
      avulsa.click();
      const options = await wait('Não encontrei o modal de pagamento.', () =>
        dialogs().find(el => field('Parcelamento', el)));
      const installments = field('Parcelamento', options);
      const openInstallments = installments.closest('.MuiAutocomplete-root')
        ?.querySelector('button[aria-label="Abrir"]');
      if (!openInstallments) throw Error('Não encontrei o botão Abrir de Parcelamento.');
      openInstallments.click();
      const twelve = await wait('Não encontrei 12 vezes.', () =>
        [...document.querySelectorAll('[role=option]')].find(el => visible(el) && text(el) === '12 vezes'));
      twelve.click();
      await wait('Não consegui confirmar Em até 12 vezes.', () =>
        normalize(installments.value) === '12 vezes' &&
        [...options.querySelectorAll('input[role=combobox]')].some(el => normalize(el.value) === 'em ate'));
      const optionText = normalize(options.innerText);
      const activeMethod = label => [...options.querySelectorAll('input[type=checkbox], [role=checkbox], [role=switch],button[aria-pressed]')].some(el=>{
        const labelText = normalize([el.getAttribute('aria-label'),el.textContent,...[...(el.labels||[])].map(l=>l.innerText),el.parentElement?.innerText].filter(Boolean).join(' '));
        return labelText.split(' ').includes(label)&&(el.checked||el.getAttribute('aria-checked')==='true'||el.getAttribute('aria-pressed')==='true');
      });
      if(!activeMethod('credito') || !activeMethod('pix')) throw Error('Confira se Crédito e Pix estão ativados no portal.');
      const moneyField = field('Valor da Venda',options);
      const saleValuePattern = /valor da venda\s*:?\s*(?:r\$\s*)?([\d.]+,\d{2})/u;
      const actualValue = moneyField?.value?.replace(/[^\d.,]/g,'') || saleValuePattern.exec(optionText)?.[1];
      if (actualValue !== money) throw Error('O Valor da Venda não foi confirmado.');
      await click('Não encontrei Próximo.', ['Próximo'],options);
      set(await wait('Não encontrei Nome do Cliente.',()=>field('Nome do Cliente')),patient);
      set(await wait('Não encontrei Descrição do Pagamento.',()=>field('Descrição do Pagamento')),patient);
      await click('Não encontrei Gerar Link.', ['Gerar Link']);
      const url = await wait('O portal não confirmou o link. Confira a venda antes de tentar novamente.',()=>{
        const success = dialogs().find(el=>normalize(el.innerText).includes('seu link foi gerado com sucesso')) ||
          (normalize(document.body.innerText).includes('seu link foi gerado com sucesso') ? document : null);
        if (!success) return null;
        const values = [...success.querySelectorAll('input,textarea,a')].filter(visible)
          .map(el => el.value || el.href || '');
        values.push(success.innerText || success.body?.innerText || '');
        const urls = new Set(values.flatMap(value => value.match(
          /https:\/\/www\.evoluservices\.com\/orders\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![a-z0-9-])/gi
        ) || []));
        return urls.size === 1 ? [...urls][0] : null;
      });
      try { await navigator.clipboard.writeText(url); } catch {}
      return {message:'Pronto. Link gerado.',url};
    } catch(error) { return {message:error.message}; }
  }
})();
