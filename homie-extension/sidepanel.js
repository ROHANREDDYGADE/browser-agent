// sidepanel.js — Homie side panel UI
const OAIKEY = 'homie_oai_key';
const TOKEN_COOKIE = 'qwise_user_token';

const sdot     = document.getElementById('sdot');
const stxt     = document.getElementById('stxt');
const rdot     = document.getElementById('rdot');
const astatus  = document.getElementById('astatus');
const stepsTxt = document.getElementById('steps');
const stopbtn  = document.getElementById('stopbtn');
const keyinput = document.getElementById('keyinput');
const keysave  = document.getElementById('keysave');
const msgsAuto = document.getElementById('msgs-auto');
const msgsChat = document.getElementById('msgs-chat');
const inputAuto= document.getElementById('input-auto');
const sendAuto = document.getElementById('send-auto');
const inputChat= document.getElementById('input-chat');
const sendChat = document.getElementById('send-chat');

// ── Key storage ────────────────────────────────────────────────────
chrome.storage.local.get(OAIKEY, r => { if (r[OAIKEY]) keyinput.value = r[OAIKEY]; });
keysave.addEventListener('click', () => {
  chrome.storage.local.set({ [OAIKEY]: keyinput.value.trim() });
  keysave.textContent = 'Saved ✓';
  setTimeout(() => keysave.textContent = 'Save', 1500);
});

// ── Tabs ───────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === `pane-${t.dataset.pane}`));
}));

// ── Status ─────────────────────────────────────────────────────────
function setStatus(txt, s) {
  stxt.textContent = txt; sdot.className = '';
  if (s) sdot.classList.add(s);
}
function setRunning(running, step) {
  rdot.classList.toggle('on', running);
  stopbtn.classList.toggle('on', running);
  sendAuto.disabled = running;
  inputAuto.disabled = running;
  if (!running) { stepsTxt.textContent = ''; astatus.textContent = 'Ready'; }
  else if (step) stepsTxt.textContent = `step ${step}`;
}

// ── Auto-resize textareas ──────────────────────────────────────────
[inputAuto, inputChat].forEach(el => el.addEventListener('input', () => {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 80) + 'px';
}));

// ── Message helpers ────────────────────────────────────────────────
function scroll(el) { requestAnimationFrame(() => el.scrollTop = el.scrollHeight); }
function hideEmpty(container) {
  const e = container.querySelector('.empty'); if (e) e.style.display = 'none';
}
const AV_AI  = `<svg viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
const AV_ACT = `<svg viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="2" stroke-linecap="round"><path d="M5 3l14 9-7 1-4 7z"/></svg>`;

function esc(t) { return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>'); }

function msgRow(container, html, cls) {
  hideEmpty(container);
  const row = document.createElement('div');
  row.className = 'mrow' + (cls === 'user' ? ' user' : '');
  if (cls === 'user')        row.innerHTML = `<div class="buser">${html}</div>`;
  else if (cls === 'action') row.innerHTML = `<div class="av">${AV_ACT}</div><div class="bact">${html}</div>`;
  else                       row.innerHTML = `<div class="av">${AV_AI}</div><div class="bai">${html}</div>`;
  container.appendChild(row); scroll(container);
  return row.querySelector('.bai,.buser,.bact');
}
function addThumb(dataUrl, label) {
  hideEmpty(msgsAuto);
  const row = document.createElement('div');
  row.className = 'mrow';
  row.innerHTML = `<div class="av">${AV_ACT}</div><div class="shot"><img src="${dataUrl}"/><div class="shot-lbl">${label}</div></div>`;
  msgsAuto.appendChild(row); scroll(msgsAuto);
}
function sysMsg(container, text, color) {
  const el = document.createElement('div');
  el.className = 'sys'; if (color) el.style.color = color;
  el.textContent = text; container.appendChild(el); scroll(container);
}

// ── Stop ───────────────────────────────────────────────────────────
stopbtn.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'STOP_CUA' }));

// ── Start agent ────────────────────────────────────────────────────
async function startAgent() {
  const task = inputAuto.value.trim(); if (!task) return;
  const stored = await chrome.storage.local.get(OAIKEY);
  const apiKey = stored[OAIKEY] || keyinput.value.trim();
  if (!apiKey) { sysMsg(msgsAuto,'⚠ Enter OpenAI API key above','#ff5555'); keyinput.focus(); return; }

  inputAuto.value = ''; inputAuto.style.height = 'auto';
  msgRow(msgsAuto, esc(task), 'user');
  setRunning(true, 0); astatus.textContent = 'Starting…';
  setStatus('running','run');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { sysMsg(msgsAuto,'⚠ No active tab','#ff5555'); setRunning(false); return; }

  chrome.runtime.sendMessage({
    type: 'START_CUA', task, apiKey,
    tabId: tab.id, currentUrl: tab.url,
  });
}
inputAuto.addEventListener('keydown', e => { if (e.key==='Enter'&&!e.shiftKey){e.preventDefault();startAgent();} });
sendAuto.addEventListener('click', startAgent);

// ── Assistant WebSocket ────────────────────────────────────────────
const AI_WS = 'wss://nfapi.nofrills.ai/ws/voice/chat/';
let wsReady=false, wsPending=null, wsLiveEl=null, wsObj=null;

async function connectWS() {
  const cookies = await chrome.cookies.getAll({ name: 'qwise_user_token' }).catch(()=>[]);
  const token = cookies[0] ? decodeURIComponent(cookies[0].value) : '';
  if (!token) { sysMsg(msgsChat,'⚠ No token — log in to Homie first','#ff5555'); return; }
  setStatus('connecting…','');
  const ws = new WebSocket(`${AI_WS}?token=${token}`);
  wsObj = ws; let buf='', started=false;
  ws.onopen  = () => { setStatus('online','on'); inputChat.disabled=sendChat.disabled=false; };
  ws.onclose = () => { wsReady=false; wsLiveEl=null; inputChat.disabled=sendChat.disabled=true; setStatus('offline',''); };
  ws.onerror = () => {};
  ws.onmessage = e => {
    let m; try{m=JSON.parse(e.data);}catch{return;}
    const t=m.type||'';
    if(t==='assistant_transcript_delta'){
      const d=m.delta||'';if(!d)return;buf+=d;started=true;
      if(!wsLiveEl)wsLiveEl=msgRow(msgsChat,'','ai');
      wsLiveEl.innerHTML=esc(buf);scroll(msgsChat);
    }else if(t==='assistant_transcript'){
      if(!started&&m.transcript)msgRow(msgsChat,esc(m.transcript),'ai');
      else if(buf&&wsLiveEl)wsLiveEl.innerHTML=esc(buf);
      buf='';started=false;wsLiveEl=null;
    }else if(t==='response_done'){
      if(buf&&started){if(wsLiveEl)wsLiveEl.innerHTML=esc(buf);buf='';started=false;wsLiveEl=null;}
      wsReady=true;
      if(wsPending){const tx=wsPending;wsPending=null;ws.send(JSON.stringify({type:'text',data:tx}));}
      else{setStatus('online','on');inputChat.disabled=sendChat.disabled=false;}
    }else if(t==='error'){
      sysMsg(msgsChat,'⚠ '+(m.error||''),'#ff5555');
      inputChat.disabled=sendChat.disabled=false;
    }
  };
}
connectWS();

function sendChat_() {
  const text=inputChat.value.trim();if(!text)return;
  inputChat.value='';inputChat.style.height='auto';
  msgRow(msgsChat,esc(text),'user');
  if(!wsReady||!wsObj){wsPending=text;return;}
  inputChat.disabled=sendChat.disabled=true;wsLiveEl=null;
  wsObj.send(JSON.stringify({type:'text',data:text}));
}
inputChat.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChat_();}});
sendChat.addEventListener('click',sendChat_);

// ── Events from background ─────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'CUA_EVENT') return;
  const {evt,data}=msg;
  if(evt==='status'){astatus.textContent=data.text;if(data.step)stepsTxt.textContent=`step ${data.step}`;return;}
  if(evt==='thinking'){const el=msgRow(msgsAuto,'','action');if(el)el.innerHTML=`<div class="albl">THINKING</div><div>${esc(data)}</div>`;return;}
  if(evt==='action'){
    const el=msgRow(msgsAuto,'','action');
    const a=data.action;
    const label = a.action==='click'?`click [${a.index}]`:a.action==='type'?`type "${(a.text||'').slice(0,40)}"`:a.action==='navigate'?`navigate ${a.url||''}`:a.action;
    if(el)el.innerHTML=`<div class="albl">STEP ${data.step}</div><div>${esc(label)}</div>`;
    return;
  }
  if(evt==='screenshot'){addThumb(data.dataUrl,`After step ${data.step}`);return;}
  if(evt==='ai_text'){msgRow(msgsAuto,esc(data),'ai');return;}
  if(evt==='warn'){sysMsg(msgsAuto,data,'#555');return;}
  if(evt==='error'){sysMsg(msgsAuto,`⚠ ${data}`,'#ff5555');setRunning(false);setStatus('idle','');return;}
  if(evt==='done'){if(data)sysMsg(msgsAuto,data);setRunning(false);setStatus('online','on');return;}
});