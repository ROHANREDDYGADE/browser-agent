// sidepanel.js — Homie side panel (Auto mode only)
(function () {
const sdot     = document.getElementById('sdot');
const stxt     = document.getElementById('stxt');
const rdot     = document.getElementById('rdot');
const astatus  = document.getElementById('astatus');
const stepsTxt = document.getElementById('steps');
const stopbtn  = document.getElementById('stopbtn');
const msgsAuto = document.getElementById('msgs-auto');
const inputAuto= document.getElementById('input-auto');
const sendAuto = document.getElementById('send-auto');
if (!inputAuto || !sendAuto || !msgsAuto) return;
// ── Status ─────────────────────────────────────────────────────────
function setStatus(txt, s) {
  stxt.textContent = txt; sdot.className = '';
  if (s) sdot.classList.add(s);
}
function setRunning(running, step) {
  rdot.classList.toggle('on', running);
  stopbtn.classList.toggle('on', running);
  sendAuto.disabled  = running;
  inputAuto.disabled = running;
  if (!running) { stepsTxt.textContent = ''; astatus.textContent = 'Ready'; }
  else if (step) stepsTxt.textContent = `step ${step}`;
}

// ── Auto-resize textarea ───────────────────────────────────────────
inputAuto.addEventListener('input', () => {
  inputAuto.style.height = 'auto';
  inputAuto.style.height = Math.min(inputAuto.scrollHeight, 80) + 'px';
});

// ── Message helpers ────────────────────────────────────────────────
function scroll(el) { requestAnimationFrame(() => el.scrollTop = el.scrollHeight); }
function hideEmpty() {
  const e = msgsAuto.querySelector('.empty');
  if (e) e.style.display = 'none';
}

const AV_AI  = `<svg viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
const AV_ACT = `<svg viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="2" stroke-linecap="round"><path d="M5 3l14 9-7 1-4 7z"/></svg>`;

function esc(t) {
  return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

function msgRow(html, cls) {
  hideEmpty();
  const row = document.createElement('div');
  row.className = 'mrow' + (cls === 'user' ? ' user' : '');
  if (cls === 'user')        row.innerHTML = `<div class="buser">${html}</div>`;
  else if (cls === 'action') row.innerHTML = `<div class="av">${AV_ACT}</div><div class="bact">${html}</div>`;
  else                       row.innerHTML = `<div class="av">${AV_AI}</div><div class="bai">${html}</div>`;
  msgsAuto.appendChild(row);
  scroll(msgsAuto);
  return row.querySelector('.bai,.buser,.bact');
}

function addThumb(dataUrl, label) {
  hideEmpty();
  const row = document.createElement('div');
  row.className = 'mrow';
  row.innerHTML = `<div class="av">${AV_ACT}</div><div class="shot"><img src="${dataUrl}"/><div class="shot-lbl">${label}</div></div>`;
  msgsAuto.appendChild(row);
  scroll(msgsAuto);
}

function sysMsg(text, color) {
  const el = document.createElement('div');
  el.className = 'sys';
  if (color) el.style.color = color;
  el.textContent = text;
  msgsAuto.appendChild(el);
  scroll(msgsAuto);
}

// ── Stop ───────────────────────────────────────────────────────────
stopbtn.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'STOP_CUA' }));

// ── Start agent ────────────────────────────────────────────────────
async function startAgent() {
  const task = inputAuto.value.trim();
  if (!task) return;

  // Verify token exists before starting
  const stored = await chrome.storage.local.get('qwise_user_token');
  if (!stored['qwise_user_token']) {
    sysMsg('⚠ Not logged in — please log in to Homie first.', '#ff5555');
    return;
  }

  inputAuto.value = '';
  inputAuto.style.height = 'auto';
  msgRow(esc(task), 'user');
  setRunning(true, 0);
  astatus.textContent = 'Starting…';
  setStatus('running', 'run');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    sysMsg('⚠ No active tab', '#ff5555');
    setRunning(false);
    return;
  }

  chrome.runtime.sendMessage({
    type: 'START_CUA',
    task,
    tabId: tab.id,
    currentUrl: tab.url,
  });
}

inputAuto.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); startAgent(); }
});
sendAuto.addEventListener('click', startAgent);

// ── Events from background ─────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'CUA_EVENT') return;
  const { evt, data } = msg;

  if (evt === 'status') {
    astatus.textContent = data.text;
    if (data.step) stepsTxt.textContent = `step ${data.step}`;
    return;
  }
  if (evt === 'thinking') {
    const el = msgRow('', 'action');
    if (el) el.innerHTML = `<div class="albl">THINKING</div><div>${esc(data)}</div>`;
    return;
  }
  if (evt === 'action') {
    const el = msgRow('', 'action');
    const a = data.action;
    const label =
      a.action === 'click'    ? `click [${a.index}]` :
      a.action === 'type'     ? `type "${(a.text || '').slice(0, 40)}"` :
      a.action === 'navigate' ? `navigate ${a.url || ''}` :
      a.action;
    if (el) el.innerHTML = `<div class="albl">STEP ${data.step}</div><div>${esc(label)}</div>`;
    return;
  }
  if (evt === 'screenshot') {
    addThumb(data.dataUrl, `After step ${data.step}`);
    return;
  }
  if (evt === 'ai_text') {
    msgRow(esc(data), 'ai');
    return;
  }
  if (evt === 'warn') {
    sysMsg(data, '#555');
    return;
  }
  if (evt === 'error') {
    sysMsg(`⚠ ${data}`, '#ff5555');
    setRunning(false);
    setStatus('idle', '');
    return;
  }
  if (evt === 'done') {
    if (data) sysMsg(data);
    setRunning(false);
    setStatus('online', 'on');
    return;
  }
});
})();