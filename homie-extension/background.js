// Load token from token.json → chrome.storage
async function loadToken() {
  try {
    const res = await fetch(chrome.runtime.getURL("token.json"));
    const data = await res.json();
    if (data.token) {
      await chrome.storage.local.set({ qwise_user_token: data.token });
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
chrome.runtime.onStartup.addListener(() => {
  console.log("🚀 Browser startup → loading token");
  loadToken();
});
loadToken();

// ── Config ─────────────────────────────────────────────────────────
const BACKEND_BASE   = "https://nfapi.nofrills.ai"; // ← change this
const AGENT_ENDPOINT = `${BACKEND_BASE}/api/v1/notes/agent/`;

const state = {
  running:             false,
  stopRequested:       false,
  step:                0,
  task:                null,
  tabId:               null,
  userToken:           null,
  lastUrl:             null,
  conversationHistory: [],
  lastActions:         [],
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

async function injectAndWait(tabId, timeout = 8000) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch(e) {
    console.warn('[Homie] inject error:', e.message);
  }
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

function getElements(tabId) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve([]), 3000);
    chrome.tabs.sendMessage(tabId, { type: 'GET_ELEMENTS' }, res => {
      clearTimeout(timer);
      if (chrome.runtime.lastError || !res) resolve([]);
      else resolve(res.elements || []);
    });
  });
}

// ── NEW: retry getElements up to N times if 0 elements returned ────
async function getElementsWithRetry(tabId, retries = 3, delay = 500) {
  for (let i = 0; i < retries; i++) {
    const elements = await getElements(tabId);
    if (elements.length > 0) return elements;
    if (i < retries - 1) {
      console.warn(`[Homie] getElements returned 0, retry ${i + 1}/${retries - 1}…`);
      await sleep(delay);
    }
  }
  console.warn('[Homie] getElements still 0 after all retries');
  return [];
}

// ── NEW: wait until element count stops changing (DOM settled) ──────
// Polls every 300ms. Resolves once the same non-zero count appears
// `stableFor` consecutive times, or when timeout is reached.
async function waitForStableDOM(tabId, timeout = 6000, stableFor = 2) {
  const deadline  = Date.now() + timeout;
  let lastCount   = -1;
  let stableStreak = 0;

  while (Date.now() < deadline) {
    if (state.stopRequested) return [];

    const elements = await getElements(tabId);
    const count    = elements.length;

    if (count > 0 && count === lastCount) {
      stableStreak++;
      if (stableStreak >= stableFor) {
        console.log(`[Homie] DOM stable at ${count} elements`);
        return elements;
      }
    } else {
      stableStreak = 0;
    }

    lastCount = count;
    await sleep(300);
  }

  // Timed out — return whatever is on the page now
  console.warn('[Homie] waitForStableDOM timed out, proceeding anyway');
  return await getElements(tabId);
}

function execAction(tabId, action) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { type: 'EXEC_ACTION', action }, res => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res || { ok: true });
    });
    setTimeout(() => resolve({ ok: true }), 5000);
  });
}

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

function formatElements(elements) {
  if (!elements.length) return 'No interactive elements found.';
  return elements.map(e => {
    let d = `[${e.index}] <${e.tag}`;
    if (e.type) d += ` type="${e.type}"`;
    if (e.role) d += ` role="${e.role}"`;
    if (e.cls)  d += ` class="${e.cls}"`;
    d += '>';
    if (e.text) d += ` "${e.text}"`;
    if (e.href) d += ` → ${e.href}`;
    return d;
  }).join('\n');
}

function emit(evt, data) {
  chrome.runtime.sendMessage({ type: 'CUA_EVENT', evt, data }).catch(() => {});
}

// ── Strip screenshots from all steps except the current one ───────
function trimmedHistory(history) {
  return history.map((msg, i) => {
    const isLast = i === history.length - 1;
    if (msg.role === 'assistant') return msg;
    if (isLast) return msg;
    if (Array.isArray(msg.content)) {
      return { ...msg, content: msg.content.filter(c => c.type !== 'image_url') };
    }
    return msg;
  });
}

// ── Detect if agent is stuck typing the same thing repeatedly ──────
function isStuckInLoop() {
  const last = state.lastActions;
  if (last.length < 4) return false;
  const recent = last.slice(-4);
  return recent.every(a => a.action === 'type' && a.text === recent[0].text);
}

// ── Backend call ───────────────────────────────────────────────────
async function callBackendAgent(messages, systemPrompt) {
  try {
    const res = await fetch(AGENT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Token ${state.userToken}`,
      },
      body: JSON.stringify({
        messages,
        system_prompt: systemPrompt,
        model: 'gpt-4o',
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        return { error: 'Authentication failed — please log in to Homie again.' };
      }
      return { error: data.message || `Server error ${res.status}` };
    }

    if (!data.status) {
      return { error: data.message || 'Backend returned failure' };
    }

    return { result: data.result };
  } catch(e) {
    return { error: `Network error: ${e.message}` };
  }
}

// ══════════════════════════════════════════════════════════════════
// AGENT LOOP
// ══════════════════════════════════════════════════════════════════
async function runAgent() {
  const tabId = state.tabId;

  emit('status', { text: 'Injecting…', running: true, step: 0 });
  const ready = await injectAndWait(tabId);
  if (!ready) {
    emit('error', 'Could not inject into page. Try refreshing the tab.');
    state.running = false;
    return;
  }

  const now = new Date();
  const currentDateTime = now.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'full',
    timeStyle: 'short'
  });

const systemPrompt = `You are a browser automation agent AND a helpful research assistant.
Current date and time: ${currentDateTime}.

You receive:
1. A screenshot of the current browser page
2. A numbered list of all interactive elements

Respond with a JSON object for ONE action:
- { "action": "click", "index": N, "reason": "..." }
- { "action": "type", "index": N, "text": "...", "clear": true, "reason": "..." }
- { "action": "key", "key": "Enter", "reason": "..." }
- { "action": "scroll", "scroll_y": 400, "reason": "..." }
- { "action": "navigate", "url": "https://...", "reason": "..." }
- { "action": "wait", "ms": 1500, "reason": "..." }
- { "action": "done", "message": "..." }
- { "action": "error", "message": "Cannot complete because..." }

════════════════════════════════════════
COMPLETION RULE — THIS IS THE MOST IMPORTANT RULE:
════════════════════════════════════════
When the task is complete, use the "done" action.
The "message" field is what the user SEES — write it like a knowledgeable assistant who just did research for them.

ALWAYS structure your done message like this:

1. ONE sentence confirming what you did.
2. The actual results, data, or findings — extracted from the page. Be specific:
   - For flights: list each option with airline, departure time, arrival time, duration, stops, and price.
   - For hotels: list each option with name, rating, price per night, and any key highlights.
   - For products: list name, price, rating, key specs.
   - For search results: summarize the top findings with key facts.
   - For forms submitted: confirm what was submitted and any confirmation number or response shown.
   - For any other task: extract and present the most relevant data visible on the page.
3. A brief recommendation or observation if it adds value (e.g. "The cheapest option is X", "The first result seems most relevant").

NEVER write a done message like:
- "I navigated to the site and found the results." ✗
- "The task is complete, you can check the page." ✗
- "Done! The page shows flight options." ✗

ALWAYS write a done message like:
- "Here are the flights from Mumbai to Delhi on April 10th:
   • IndiGo 6E-123 | Dep 06:00 → Arr 08:10 | 2h 10m | Non-stop | ₹3,499
   • Air India AI-401 | Dep 09:30 → Arr 11:45 | 2h 15m | Non-stop | ₹4,200
   • SpiceJet SG-701 | Dep 14:00 → Arr 16:20 | 2h 20m | Non-stop | ₹3,199 ← cheapest
   Prices are one-way, economy class as of today." ✓

════════════════════════════════════════
NAVIGATION & INTERACTION RULES:
════════════════════════════════════════
- Use element INDEX not coordinates
- To visit a site: use navigate
- For city/location inputs on travel sites (MakeMyTrip, RedBus etc):
    1. Click the input field first
    2. Type the city name
    3. ALWAYS follow with a 'wait' action for 1500ms — the dropdown takes time to appear on React sites
    4. On the NEXT step after waiting, new dropdown suggestion elements will be visible — click the correct one
    5. Never type the same text more than TWICE in a row — if stuck, use Escape and start fresh
    6. If no dropdown appeared after 2 type attempts: action=key key=Escape, then click the field again, then type
- Element indices change after every click on React/SPA sites — never reuse an index from a previous step
- After selecting a dropdown suggestion always wait 800ms before moving to the next field
- For date pickers and calendars:
    1. Click the date input field first to open the calendar
    2. Follow with a wait of 800ms for the calendar to open
    3. Find the exact date number element in the calendar grid and click it directly
    4. Never try to type a date into a calendar picker — always click the date
- After each navigation or major click, wait for the page to settle before acting
- If results are paginated or cut off, scroll down to gather more before calling done`;

  const MAX = 30;

  while (state.step < MAX) {
    if (state.stopRequested) {
      emit('done', 'Stopped.');
      state.running = false;
      return;
    }

    // ── Stuck loop detection ────────────────────────────────────────
    if (isStuckInLoop()) {
      emit('warn', 'Detected stuck loop — recovering…');
      await execAction(tabId, { type: 'key', key: 'Escape' });
      await sleep(500);
      state.lastActions = [];
      state.conversationHistory = state.conversationHistory.slice(0, -6);
      state.conversationHistory.push({
        role: 'user',
        content: [{
          type: 'text',
          text: 'SYSTEM NOTE: You were stuck typing the same text repeatedly with no result. The field has been reset with Escape. Please try a completely different approach — click the input field fresh, type the text, then use a wait action for 1500ms before trying to click any suggestion.'
        }]
      });
      continue;
    }

    state.step++;
    emit('status', { text: `Step ${state.step}…`, running: true, step: state.step });

    // ── FIX: wait for DOM to fully settle before reading elements ──
    emit('status', { text: `Waiting for page to settle… (step ${state.step})`, running: true, step: state.step });
    await waitForStableDOM(tabId);

    const [screenshot, elements, pageInfo] = await Promise.all([
      captureTab(),
      getElementsWithRetry(tabId),   // ── FIX: retry on 0 elements
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

    // Warn in the prompt if we still ended up with no elements
    const elementSection = elements.length === 0
      ? 'WARNING: No interactive elements detected on this page yet. The page may still be loading or requires scrolling. Consider using a scroll or wait action.'
      : `INTERACTIVE ELEMENTS:\n${elementList}`;

    const userContent = [{
      type: 'text',
      text: `URL: ${pageInfo.url || 'unknown'}\nTitle: ${pageInfo.title || ''}\n\n${elementSection}\n\nTask: ${state.task}\nWhat is your next action?`
    }];
    if (screenshot) {
      userContent.push({ type: 'image_url', image_url: { url: screenshot } });
    }

    state.conversationHistory.push({ role: 'user', content: userContent });

    const response = await callBackendAgent(trimmedHistory(state.conversationHistory), systemPrompt);

    if (state.stopRequested) { emit('done', 'Stopped.'); state.running = false; return; }

    if (response.error) {
      emit('error', response.error);
      state.running = false;
      return;
    }

    const aiAction = response.result;
    state.conversationHistory.push({ role: 'assistant', content: JSON.stringify(aiAction) });

    state.lastActions.push(aiAction);
    if (state.lastActions.length > 10) state.lastActions.shift();

    if (aiAction.reason) emit('thinking', aiAction.reason);

    // ── Execute ────────────────────────────────────────────────────
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
      // ── FIX: replace fixed sleep with stable DOM wait ──────────
      await waitForStableDOM(tabId);
      continue;
    }

    if (aiAction.action === 'click') {
      emit('action', { step: state.step, action: aiAction });
      const result = await execAction(tabId, { type: 'click', index: aiAction.index });
      if (!result.ok) emit('warn', `Click [${aiAction.index}] failed: ${result.error}`);
      // ── FIX: wait for load then stable DOM, not just fixed sleeps
      await waitForLoad(tabId);
      await injectAndWait(tabId, 3000);
      await waitForStableDOM(tabId);
      continue;
    }

    if (aiAction.action === 'type') {
      emit('action', { step: state.step, action: aiAction });
      await execAction(tabId, {
        type: 'type', index: aiAction.index,
        text: aiAction.text || '', clear: aiAction.clear !== false
      });
      // Give React time to process input and render dropdown suggestions
      // ── FIX: increased from 900ms + added a short stable check ──
      await sleep(400);
      await waitForStableDOM(tabId, 2500, 2);
      continue;
    }

    if (aiAction.action === 'key') {
      emit('action', { step: state.step, action: aiAction });
      await execAction(tabId, { type: 'key', key: aiAction.key, keys: aiAction.key });
      await waitForLoad(tabId);
      await injectAndWait(tabId, 3000);
      // ── FIX: stable DOM instead of fixed sleep ─────────────────
      await waitForStableDOM(tabId);
      continue;
    }

    if (aiAction.action === 'scroll') {
      emit('action', { step: state.step, action: aiAction });
      await execAction(tabId, { type: 'scroll', scroll_x: 0, scroll_y: aiAction.scroll_y || 400 });
      // ── FIX: short stable wait so newly revealed elements are counted
      await sleep(200);
      await waitForStableDOM(tabId, 2000, 2);
      continue;
    }

    if (aiAction.action === 'wait') {
      emit('action', { step: state.step, action: aiAction });
      const waitMs = Math.min(aiAction.ms || 1000, 5000);
      const chunk  = 200;
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

    chrome.storage.local.get('qwise_user_token', stored => {
      const token = stored['qwise_user_token']
        ? decodeURIComponent(stored['qwise_user_token'])
        : null;

      if (!token) {
        emit('error', 'Not logged in — please log in to Homie first.');
        sendResponse({ error: 'No token' });
        return;
      }

      state.running             = true;
      state.stopRequested       = false;
      state.step                = 0;
      state.tabId               = msg.tabId;
      state.userToken           = token;
      state.task                = msg.task;
      state.lastUrl             = msg.currentUrl || null;
      state.conversationHistory = [];
      state.lastActions         = [];
      runAgent();
      sendResponse({ ok: true });
    });

    return true;
  }

  if (msg.type === 'STOP_CUA') {
    state.stopRequested = true;
    state.running       = false;
    emit('done', 'Stopped.');
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'CUA_STATUS') {
    sendResponse({ running: state.running, step: state.step });
    return true;
  }
});