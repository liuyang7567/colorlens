const systemPreference = matchMedia('(prefers-reduced-motion: reduce)');
const storageKey = 'colorlens.motion';
let reduced = false;
try { reduced = localStorage.getItem(storageKey) === 'reduced'; } catch { /* Storage can be unavailable in private browsing. */ }

function renderButton(button) {
  const enabled = !reduced && !systemPreference.matches;
  button.setAttribute('aria-pressed', String(enabled));
  button.disabled = systemPreference.matches;
  button.title = systemPreference.matches ? '已跟随系统减少动态效果' : enabled ? '关闭界面动效' : '开启界面动效';
  button.querySelector('span').textContent = enabled ? '动效已开' : '动效已关';
}

function applyPreference() {
  document.documentElement.dataset.motion = reduced || systemPreference.matches ? 'reduced' : 'full';
  document.querySelectorAll('[data-motion-toggle]').forEach(renderButton);
}

export function motionButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'motion-toggle';
  button.dataset.motionToggle = '';
  button.setAttribute('aria-label', '界面动效');
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 14h4l3-8 4 13 3-10 2 5h4"/></svg><span></span>';
  renderButton(button);
  button.addEventListener('click', () => {
    reduced = !reduced;
    try { localStorage.setItem(storageKey, reduced ? 'reduced' : 'system'); } catch { /* Still applies to this tab. */ }
    applyPreference();
  });
  return button;
}

systemPreference.addEventListener('change', applyPreference);
window.addEventListener('storage', event => {
  if (event.key !== storageKey && event.key !== null) return;
  reduced = event.newValue === 'reduced';
  applyPreference();
});
applyPreference();
