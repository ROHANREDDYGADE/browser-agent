
// Load token from token.json → chrome.storage
async function loadToken() {
  try {
    const res = await fetch(chrome.runtime.getURL("token.json"));
    const data = await res.json();

    if (data.token) {
      await chrome.storage.local.set({
        qwise_user_token: data.token
      });
      console.log("✅ Token loaded");
    }
  } catch (e) {
    console.log("No token.json yet");
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("🔁 Extension installed → loading token");
  loadToken();
});

// run when browser starts
chrome.runtime.onStartup.addListener(() => {
  console.log("🚀 Browser startup → loading token");
  loadToken();
});

// run on startup
loadToken();
const state = {
  running:        false,
  stopRequested:  false,
  step:           0,
  task:           null,
  tabId:          null,
  apiKey:         null,
  lastUrl:        null,
  conversationHistory: [],
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

chrome.action.onClicked.addListener(tab => {
  chrome.sidePanel.open({ tabId: tab.id });
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

function getTab(tabId) {
  return new Promise(r => chrome.tabs.get(tabId, t => {
    if (chrome.runtime.lastError) r(null); else r(t);
  }));
}
function activateTab(tabId) {
  return new Promise(r => chrome.tabs.update(tabId, { active: true }, () => {
    chrome.runtime.lastError; r();
  }));
}
function navigateTab(tabId, url) {
  return new Promise(r => chrome.tabs.update(tabId, { url }, () => {
    chrome.runtime.lastError; r();
  }));
}
function waitForLoad(tabId, timeout = 20000) {
  return new Promise(resolve => {
    function onUp(tid, info) {
      if (tid === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUp);
        clearTimeout(fb);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUp);
    const fb = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUp);
      resolve();
    }, timeout);
  });
}

// ── Inject content script and wait for it to be ready ─────────────
async function injectAndWait(tabId, timeout = 8000) {
  // Always re-inject — idempotent because content.js checks __homie_loaded
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch(e) {
    console.warn('[Homie] inject error:', e.message);
  }
  // Wait for PING response
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ready = await new Promise(resolve => {
      chrome.tabs.sendMessage(tabId, { type: 'PING' }, res => {
        if (chrome.runtime.lastError) resolve(false);
        else resolve(!!res?.pong);
      });
    });
    if (ready) return true;
    await sleep(300);
  }
  return false;
}

// ── Re-inject on navigation ────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (tabId !== state.tabId || info.status !== 'complete') return;
  if (!tab.url?.startsWith('http')) return;
  if (tab.url === state.lastUrl) return;
  state.lastUrl = tab.url;
  setTimeout(() => {
    chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }, () => {
      chrome.runtime.lastError;
    });
  }, 500);
});

// ── Block new tabs ─────────────────────────────────────────────────
chrome.tabs.onCreated.addListener(tab => {
  if (!state.running || !state.tabId) return;
  const url = tab.pendingUrl || tab.url;
  chrome.tabs.remove(tab.id, () => { chrome.runtime.lastError; });
  if (url && url !== 'about:blank' && url !== 'chrome://newtab/') {
    state.lastUrl = null;
    navigateTab(state.tabId, url);
    emit('warn', `New tab → navigating: ${url}`);
  }
});

// ── Get elements ───────────────────────────────────────────────────
function getElements(tabId) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { type: 'GET_ELEMENTS' }, res => {
      if (chrome.runtime.lastError || !res) resolve([]);
      else resolve(res.elements || []);
    });
    setTimeout(() => resolve([]), 3000);
  });
}

// ── Execute action ─────────────────────────────────────────────────
function execAction(tabId, action) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { type: 'EXEC_ACTION', action }, res => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res || { ok: true });
    });
    setTimeout(() => resolve({ ok: true }), 5000);
  });
}

// ── Screenshot ─────────────────────────────────────────────────────
async function captureTab() {
  const tabId = state.tabId;
  if (!tabId) return null;
  await activateTab(tabId);
  await sleep(100);
  const tab = await getTab(tabId);
  if (!tab) return null;
  return new Promise(resolve => {
    chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, d => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(d);
    });
  });
}

// ── Format elements for AI ─────────────────────────────────────────
function formatElements(elements) {
  if (!elements.length) return 'No interactive elements found.';
  return elements.map(e => {
    let d = `[${e.index}] <${e.tag}`;
    if (e.type) d += ` type="${e.type}"`;
    if (e.role) d += ` role="${e.role}"`;
    if (e.cls) d += ` class="${e.cls}"`;
    d += '>';
    if (e.text) d += ` "${e.text}"`;
    if (e.href) d += ` → ${e.href}`;
    return d;
  }).join('\n');
}

function emit(evt, data) {
  chrome.runtime.sendMessage({ type: 'CUA_EVENT', evt, data }).catch(() => {});
}

// ── OpenAI ────────────────────────────────────────────────────────
async function callOpenAI(messages) {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${state.apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages,
        temperature: 0,
        response_format: { type: 'json_object' },
      })
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error?.message || `HTTP ${res.status}` };
    const content = data.choices?.[0]?.message?.content || '{}';
    try { return { result: JSON.parse(content) }; }
    catch(e) { return { error: 'Bad JSON: ' + content.slice(0, 100) }; }
  } catch(e) {
    return { error: e.message };
  }
}

// ══════════════════════════════════════════════════════════════════
// AGENT LOOP
// ══════════════════════════════════════════════════════════════════
async function runAgent() {
  const tabId = state.tabId;

  // STEP 0: inject content script into the active tab right now
  emit('status', { text: 'Injecting…', running: true, step: 0 });
  const ready = await injectAndWait(tabId);
  if (!ready) {
    emit('error', 'Could not inject into page. Try refreshing the tab.');
    state.running = false;
    return;
  }

  const systemPrompt = `You are a browser automation agent. You receive:
1. A screenshot of the current browser page
2. A numbered list of all interactive elements

Respond with a JSON object for ONE action:
- { "action": "click", "index": N, "reason": "..." }
- { "action": "type", "index": N, "text": "...", "clear": true, "reason": "..." }
- { "action": "key", "key": "Enter", "reason": "..." }
- { "action": "scroll", "scroll_y": 400, "reason": "..." }
- { "action": "navigate", "url": "https://...", "reason": "..." }
- { "action": "wait", "ms": 1500, "reason": "..." }
- { "action": "done", "message": "Full answer here..." }
- { "action": "error", "message": "Cannot complete because..." }

RULES:
- Use element INDEX not coordinates
- To visit a site: use navigate
- For city/location inputs on travel sites: click the input field, then type the city name, then WAIT - a dropdown of suggestions will appear. On the NEXT step you will see those suggestions as new elements - click the correct one.
- Never type the same text twice. If you typed and no suggestion appeared, scroll down or try a shorter city name.
- After selecting a suggestion from dropdown, move to the next field
- After each navigation or major click, wait for the page to settle
- When task complete, use done with a full helpful answer`;

  const MAX = 30;

  while (state.step < MAX) {
    // CHECK STOP at the START of every iteration — immediate response
    if (state.stopRequested) {
      emit('done', 'Stopped.');
      state.running = false;
      return;
    }

    state.step++;
    emit('status', { text: `Step ${state.step}…`, running: true, step: state.step });

    // Get page state
    const [screenshot, elements, pageInfo] = await Promise.all([
      captureTab(),
      getElements(tabId),
      new Promise(r => {
        chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_INFO' }, res => {
          chrome.runtime.lastError; r(res || {});
        });
        setTimeout(() => r({}), 2000);
      })
    ]);

    if (state.stopRequested) { emit('done', 'Stopped.'); state.running = false; return; }

    const elementList = formatElements(elements);
    emit('status', { text: `Thinking… (${elements.length} elements)`, running: true, step: state.step });

    // Build message
    const userContent = [];
    userContent.push({
      type: 'text',
      text: `URL: ${pageInfo.url || 'unknown'}\nTitle: ${pageInfo.title || ''}\n\nINTERACTIVE ELEMENTS:\n${elementList}\n\nTask: ${state.task}\nWhat is your next action?`
    });
    if (screenshot) {
      userContent.push({ type: 'image_url', image_url: { url: screenshot } });
    }

    state.conversationHistory.push({ role: 'user', content: userContent });

    const messages = [
      { role: 'system', content: systemPrompt },
      ...state.conversationHistory
    ];

    const response = await callOpenAI(messages);

    if (state.stopRequested) { emit('done', 'Stopped.'); state.running = false; return; }

    if (response.error) {
      emit('error', response.error);
      state.running = false;
      return;
    }

    const aiAction = response.result;
    state.conversationHistory.push({ role: 'assistant', content: JSON.stringify(aiAction) });

    if (aiAction.reason) emit('thinking', aiAction.reason);

    // ── Execute ─────────────────────────────────────────────────
    if (aiAction.action === 'done') {
      emit('ai_text', aiAction.message || 'Task completed.');
      emit('done', '✓ Done');
      state.running = false;
      return;
    }

    if (aiAction.action === 'error') {
      emit('ai_text', aiAction.message || 'Could not complete.');
      emit('done', 'Could not complete.');
      state.running = false;
      return;
    }

    if (aiAction.action === 'navigate') {
      let url = (aiAction.url || '').trim();
      if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
      emit('action', { step: state.step, action: aiAction });
      state.lastUrl = null;
      await navigateTab(tabId, url);
      await waitForLoad(tabId);
      await injectAndWait(tabId);
      await sleep(800);
      continue;
    }

    if (aiAction.action === 'click') {
      emit('action', { step: state.step, action: aiAction });
      const result = await execAction(tabId, { type: 'click', index: aiAction.index });
      if (!result.ok) emit('warn', `Click [${aiAction.index}] failed: ${result.error}`);
      await sleep(600);
      await waitForLoad(tabId);
      // Re-inject after click in case page navigated
      await injectAndWait(tabId, 3000);
      await sleep(400);
      continue;
    }

    if (aiAction.action === 'type') {
      emit('action', { step: state.step, action: aiAction });
      await execAction(tabId, {
        type: 'type', index: aiAction.index,
        text: aiAction.text || '', clear: aiAction.clear !== false
      });
      // Wait for autocomplete/suggestions to appear, then continue
      // so the AI gets fresh elements including dropdown suggestions
      await sleep(900);
      continue;
    }

    if (aiAction.action === 'key') {
      emit('action', { step: state.step, action: aiAction });
      await execAction(tabId, { type: 'key', key: aiAction.key, keys: aiAction.key });
      await sleep(600);
      await waitForLoad(tabId);
      await injectAndWait(tabId, 3000);
      await sleep(400);
      continue;
    }

    if (aiAction.action === 'scroll') {
      emit('action', { step: state.step, action: aiAction });
      await execAction(tabId, { type: 'scroll', scroll_x: 0, scroll_y: aiAction.scroll_y || 400 });
      await sleep(400);
      continue;
    }

    if (aiAction.action === 'wait') {
      emit('action', { step: state.step, action: aiAction });
      // Check stop during wait
      const waitMs = Math.min(aiAction.ms || 1000, 5000);
      const chunk = 200;
      for (let elapsed = 0; elapsed < waitMs; elapsed += chunk) {
        if (state.stopRequested) { emit('done', 'Stopped.'); state.running = false; return; }
        await sleep(Math.min(chunk, waitMs - elapsed));
      }
      continue;
    }
  }

  emit('done', state.stopRequested ? 'Stopped.' : `Reached max steps (${MAX})`);
  state.running = false;
}

// ── Message handler ────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'START_CUA') {
    if (state.running) { sendResponse({ error: 'Already running' }); return true; }
    state.running = true;
    state.stopRequested = false;
    state.step = 0;
    state.tabId = msg.tabId;
    state.apiKey = msg.apiKey;
    state.task = msg.task;
    state.lastUrl = msg.currentUrl || null;
    state.conversationHistory = [];
    runAgent();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'STOP_CUA') {
    // Immediate stop — flag checked at every step boundary
    state.stopRequested = true;
    state.running = false;
    emit('done', 'Stopped.');
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'CUA_STATUS') {
    sendResponse({ running: state.running, step: state.step });
    return true;
  }
});