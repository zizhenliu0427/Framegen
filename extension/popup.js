// Framegen toolbar popup: READ-ONLY status/metadata for the active tab.
// All controls live in the in-player UI by design.
const $ = (id) => document.getElementById(id);
const t = FramegenI18n.t;

let tabId = null;

async function askStatus() {
  if (tabId == null) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'fcStatus' });
  } catch { return null; } // no content script (chrome:// pages, store, etc.)
}

function render(s) {
  const dot = $('dot'), state = $('state'), stat = $('stat'), sys = $('sys');
  if (!s) {
    dot.classList.remove('on');
    state.textContent = t('popup_state_off');
    state.className = '';
    stat.textContent = '';
    sys.textContent = '';
    return;
  }
  $('ver').textContent = 'v' + s.version;
  dot.classList.toggle('on', s.running);
  state.textContent = s.running ? t('popup_state_running') : t('popup_state_off');
  state.className = s.running ? 'on' : '';
  const outputRate = s.targetState && !['factor', 'active'].includes(s.targetState)
    ? `${s.rateLabel} · ${s.targetWarning || s.targetState}`
    : s.rateClamped
      ? `${s.rateLabel} → ${s.effectiveTargetHz} FPS (${s.targetReason})`
      : s.rateLabel || (s.factor === 'auto' ? 'Auto' : `${s.factor}x source`);
  stat.textContent = s.running
    ? t('popup_stat', { fps: s.fps, rate: outputRate, ms: s.ms, res: s.res, drops: s.drops, model: s.model })
    : '';
  sys.textContent = t('popup_sys', { gpu: s.gpu || '-', f16: s.f16 ? 'yes' : 'no' })
    + (s.integrated ? t('popup_sys_integrated') : '');
  sys.className = s.integrated ? 'warn' : '';
}

const showTab = (help) => {
  $('status').style.display = help ? 'none' : 'block';
  $('help').style.display = help ? 'block' : 'none';
  $('tabStatus').classList.toggle('act', !help);
  $('tabHelp').classList.toggle('act', help);
};
$('tabStatus').onclick = () => showTab(false);
$('tabHelp').onclick = () => showTab(true);
$('fullSettings').onclick = async () => {
  try {
    await chrome.runtime.openOptionsPage();
    window.close();
  } catch { /* leave the popup open if Chrome rejects the options request */ }
};

(async () => {
  await FramegenI18n.init();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  const first = await askStatus();
  FramegenI18n.translatePage();
  render(first);
  if (first && first.integrated) showTab(true);
  setInterval(async () => render(await askStatus()), 1000);

  const langBtn = document.getElementById('langSwitch');
  const langs = FramegenI18n.availableLangs();
  function updateLangBtn() {
    const labels = { en: 'EN', en_GB: 'AU', zh: '中文' };
    langBtn.textContent = '🌐 ' + (labels[FramegenI18n.getLang()] || 'EN');
  }
  updateLangBtn();
  langBtn.onclick = () => {
    const idx = langs.indexOf(FramegenI18n.getLang());
    const next = langs[(idx + 1) % langs.length];
    FramegenI18n.setLang(next);
    updateLangBtn();
    FramegenI18n.translatePage();
    const s2 = render;
    askStatus().then(render);
  };
})();
