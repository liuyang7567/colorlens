(() => {
  'use strict';
  document.documentElement.dataset.visualTheme='scientific-a';
  const main=document.getElementById('main-workspace');
  function navigationIcons(){
    const paths={templates:'<path d="m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5"/>',teams:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v3"/>',samples:'<path d="M8 3h8M9 3v9l-5 7a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2l-5-7V3M8 15h8"/>',inventory:'<path d="m3 7 9-4 9 4v11l-9 4-9-4V7ZM3 7l9 4 9-4M12 11v11"/>',equipment:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v5M17 3v5M3 11h18M8 15h2M14 15h2"/>',collaboration:'<path d="M21 11a8 8 0 0 1-8 8H8l-5 3V7a5 5 0 0 1 5-5h7a6 6 0 0 1 6 6v3ZM7 7h10M7 11h7"/>'};
    paths.glasses='<path d="M3 12s3-6 9-6 9 6 9 6-3 6-9 6-9-6-9-6Z"/><circle cx="12" cy="12" r="3"/>';
    for(const [name,path] of Object.entries(paths)){const button=document.getElementById('nav-'+name);if(button&&!button.querySelector('svg')){const wrapper=document.createElement('span');wrapper.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true">'+path+'</svg>';button.prepend(wrapper.firstElementChild);}}
  }
  document.addEventListener('DOMContentLoaded',navigationIcons);
  document.addEventListener('DOMContentLoaded',()=>{
    const nav=document.querySelector('.mobile-nav');
    const primary=new Set(['notebook','glasses','analysis','ai']);
    const more=document.createElement('details');
    more.className='mobile-tools';
    more.innerHTML='<summary>更多工具</summary><div class="mobile-tools-list"></div>';
    const list=more.lastElementChild;
    for(const button of nav.querySelectorAll('[data-view]')){
      button.classList.remove('nav-button');
      if(!primary.has(button.dataset.view))list.append(button);
    }
    nav.append(more);
    list.addEventListener('click',event=>{if(event.target.closest('button')){more.open=false;more.firstElementChild.focus();}});
    more.addEventListener('keydown',event=>{if(event.key==='Escape'&&more.open){more.open=false;more.firstElementChild.focus();}});
    document.addEventListener('click',event=>{if(more.open&&!more.contains(event.target))more.open=false;});
    const navigation = document.querySelector('.sidebar nav');
    const groups = [
      ['实验工作台', ['notebook', 'glasses', 'workbench', 'ai', 'archive']],
      ['实验室管理', ['templates', 'samples', 'inventory', 'equipment', 'teams', 'collaboration']],
      ['资料与帮助', ['backup', 'guide']]
    ];
    for (const [label, identifiers] of groups) {
      const group = document.createElement('div');
      group.className = 'nav-group';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', label);
      const heading = document.createElement('span');
      heading.className = 'nav-group-title';
      heading.setAttribute('aria-hidden', 'true');
      heading.textContent = label;
      group.append(heading);
      for (const identifier of identifiers) {
        const button = document.getElementById('nav-' + identifier);
        if (button) group.append(button);
      }
      if (group.children.length > 1) navigation.append(group);
    }
    for (const button of nav.querySelectorAll(':scope > [data-view]')) {
      const name = button.dataset.view === 'analysis' ? 'workbench' : button.dataset.view;
      const icon = document.querySelector('#nav-' + name + ' svg')?.cloneNode(true);
      if (icon) { icon.setAttribute('aria-hidden', 'true'); button.prepend(icon); }
    }
    more.firstElementChild.insertAdjacentHTML('afterbegin','<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>');
  });
  document.querySelector('.scientific-skip')?.addEventListener('click',event=>{event.preventDefault();main?.focus();main?.scrollIntoView({block:'start'});});
  function searchExperiments(){
    if(document.querySelector('dialog[open]')||document.getElementById('cloud-auth')?.hidden===false)return;
    window.ColorLensNotebook?.focusSearch();
  }
  document.getElementById('workspace-search')?.addEventListener('click',searchExperiments);
  document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&!event.altKey&&event.key.toLowerCase()==='k'&&!document.querySelector('dialog[open]')&&document.getElementById('cloud-auth')?.hidden!==false){event.preventDefault();searchExperiments();}});
})();
