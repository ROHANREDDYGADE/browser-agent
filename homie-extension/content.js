(function () {
  if (window.__homie_loaded) return;
  window.__homie_loaded = true;

  let elementMap = {};

  // ── Get ALL interactive elements including divs with handlers ──
  function getInteractiveElements() {
    elementMap = {};
    const results = [];
    let idx = 0;
    const seen = new Set();

    // Much broader selector — catches styled divs used as buttons
    const sel = [
      // Standard interactive
      'a[href]', 'button', 'input:not([type="hidden"])', 'textarea', 'select',
      // ARIA roles
      '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
      '[role="option"]', '[role="checkbox"]', '[role="radio"]', '[role="combobox"]',
      '[role="listbox"]', '[role="switch"]', '[role="treeitem"]', '[role="gridcell"]',
      '[role="columnheader"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
      // Common patterns for styled divs acting as buttons
      '[onclick]', '[tabindex="0"]', '[tabindex="-1"]',
      '[contenteditable="true"]', '[contenteditable=""]',
      // Common class patterns on travel/booking sites
      '[class*="btn"]', '[class*="button"]', '[class*="tab"]', '[class*="chip"]',
      '[class*="option"]', '[class*="select"]', '[class*="dropdown"]',
      '[class*="clickable"]', '[class*="cursor"]', '[class*="link"]',
      '[class*="item"]', '[class*="card"]', '[class*="tile"]',
      // Data attributes commonly used for click targets
      '[data-cy]', '[data-testid]', '[data-id]', '[data-action]',
      // Summary/details
      'summary', 'label',
    ].join(',');

    // Also get elements with event listeners via a heuristic:
    // elements that have cursor:pointer in computed style are clickable
    const allElements = document.querySelectorAll('*');
    const pointerEls = new Set();
    // Sample every element — too slow to do all, so check visible ones
    document.querySelectorAll('div, span, li, td, th, p, h1, h2, h3, h4, h5, h6, img, svg').forEach(el => {
      try {
        const cs = window.getComputedStyle(el);
        if (cs.cursor === 'pointer') pointerEls.add(el);
      } catch(e) {}
    });

    const candidates = new Set([
      ...document.querySelectorAll(sel),
      ...pointerEls
    ]);

    candidates.forEach(el => {
      if (seen.has(el)) return;
      seen.add(el);

      // Skip hidden
      try {
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.05) return;
      } catch(e) { return; }

      if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return;

      // Skip if covered by another element (basic check)
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      // Allow slightly off-screen elements (important for sticky headers)
      if (rect.bottom < -50 || rect.top > window.innerHeight + 50) return;

      // Skip if it's a container with many clickable children (avoid duplicates)
      // e.g. don't index a <nav> if it has 10 <a> children already indexed
      const childClickable = el.querySelectorAll('a, button, [role="button"], input').length;
      if (childClickable > 3 && !['INPUT','TEXTAREA','SELECT','A','BUTTON'].includes(el.tagName)) return;

      const text = [
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('placeholder'),
        el.getAttribute('alt'),
        el.getAttribute('data-cy'),
        el.getAttribute('data-testid'),
        el.value,
        el.innerText,
      ].filter(Boolean).map(s => s.trim()).join(' ').replace(/\s+/g, ' ').slice(0, 100);

      elementMap[idx] = el;
      results.push({
        index: idx,
        tag:   el.tagName.toLowerCase(),
        type:  el.getAttribute('type') || '',
        role:  el.getAttribute('role') || '',
        text,
        href:  el.href ? el.href.slice(0, 80) : '',
        cls:   (el.className || '').toString().slice(0, 60),
      });
      idx++;
    });

    return results;
  }

  // ── React/Vue native value setter ─────────────────────────────
  function setNativeValue(el, value) {
    const proto = el.tagName === 'INPUT'
      ? window.HTMLInputElement.prototype
      : window.HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  function triggerInputEvents(el) {
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Process' }));
    el.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true, cancelable: true, key: 'Process' }));
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Execute action ────────────────────────────────────────────
  async function execAction(action) {
    const t = action.type;

    // ── CLICK ────────────────────────────────────────────────────
    if (t === 'click') {
      const el = elementMap[action.index];
      if (!el) return { ok: false, error: `No element at index ${action.index}` };

      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      await sleep(80);

      const rect = el.getBoundingClientRect();
      const cx = Math.round(rect.left + rect.width / 2);
      const cy = Math.round(rect.top + rect.height / 2);
      const evtInit = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, buttons: 1 };

      // Full sequence: pointer + mouse + native click
      try { el.dispatchEvent(new PointerEvent('pointerover',  { ...evtInit, pointerId: 1, bubbles: true })); } catch(e){}
      try { el.dispatchEvent(new PointerEvent('pointerenter', { ...evtInit, pointerId: 1, bubbles: false })); } catch(e){}
      try { el.dispatchEvent(new MouseEvent('mouseover', evtInit)); } catch(e){}
      try { el.dispatchEvent(new MouseEvent('mouseenter', { ...evtInit, bubbles: false })); } catch(e){}
      try { el.dispatchEvent(new PointerEvent('pointerdown', { ...evtInit, pointerId: 1 })); } catch(e){}
      try { el.dispatchEvent(new MouseEvent('mousedown', evtInit)); } catch(e){}
      try { el.focus({ preventScroll: true }); } catch(e){}
      await sleep(30);
      try { el.dispatchEvent(new PointerEvent('pointerup', { ...evtInit, pointerId: 1 })); } catch(e){}
      try { el.dispatchEvent(new MouseEvent('mouseup', evtInit)); } catch(e){}
      try { el.dispatchEvent(new MouseEvent('click', evtInit)); } catch(e){}

      // Native .click() last — most reliable for <a> and <button>
      if (typeof el.click === 'function') {
        try { el.click(); } catch(e){}
      }

      // If it's a link with href, also try programmatic navigation
      if (el.tagName === 'A' && el.href && !el.href.startsWith('javascript')) {
        // Don't navigate — let the click handle it
      }

      return { ok: true, tag: el.tagName.toLowerCase(), text: (el.innerText || '').slice(0, 40) };
    }

    // ── TYPE ─────────────────────────────────────────────────────
  // Replace the TYPE section in execAction with this:
  if (t === 'type') {
    let el = null;
    if (action.index !== undefined && action.index !== null) {
      el = elementMap[action.index];
    }
    if (!el) el = document.activeElement;
    if (!el || el === document.body) return { ok: false, error: 'No element to type into' };

    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus({ preventScroll: true });
    await sleep(100);

    if (el.isContentEditable) {
      if (action.clear !== false) el.textContent = '';
      document.execCommand('insertText', false, action.text || '');
      return { ok: true };
    }

    // Clear properly
    if (action.clear !== false) {
      el.focus();
      // Select all and delete — works better than setNativeValue for React
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      await sleep(50);
    }

    // Type character by character with real input events — React needs this
    for (const char of (action.text || '')) {
      // Set value incrementally so React state updates per character
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set;
      const currentVal = el.value;
      if (nativeInputValueSetter) nativeInputValueSetter.call(el, currentVal + char);
      else el.value = currentVal + char;

      el.dispatchEvent(new KeyboardEvent('keydown',  { key: char, bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true, cancelable: true }));
      await sleep(40); // small delay between chars — gives React time to update
    }

    return { ok: true, value: el.value };
  }

    // ── KEY ──────────────────────────────────────────────────────
    if (t === 'key') {
      const keys  = (action.keys || action.key || '').toLowerCase();
      const parts = keys.split('+');
      const main  = parts[parts.length - 1];
      const keyNames = {
        'enter':'Enter','return':'Enter','tab':'Tab','escape':'Escape','esc':'Escape',
        'backspace':'Backspace','delete':'Delete','arrowup':'ArrowUp','arrowdown':'ArrowDown',
        'arrowleft':'ArrowLeft','arrowright':'ArrowRight',
        'up':'ArrowUp','down':'ArrowDown','left':'ArrowLeft','right':'ArrowRight',
        'home':'Home','end':'End','pageup':'PageUp','pagedown':'PageDown','space':' ',
      };
      const init = {
        key: keyNames[main] || main, bubbles: true, cancelable: true,
        ctrlKey:  parts.includes('ctrl') || parts.includes('control'),
        shiftKey: parts.includes('shift'),
        altKey:   parts.includes('alt'),
        metaKey:  parts.includes('meta') || parts.includes('cmd'),
      };
      const target = document.activeElement || document.body;
      target.dispatchEvent(new KeyboardEvent('keydown',  init));
      target.dispatchEvent(new KeyboardEvent('keypress', init));
      target.dispatchEvent(new KeyboardEvent('keyup',    init));
      return { ok: true };
    }

    // ── SCROLL ───────────────────────────────────────────────────
    if (t === 'scroll') {
      window.scrollBy({ top: action.scroll_y || 0, left: action.scroll_x || 0, behavior: 'smooth' });
      return { ok: true };
    }

    // ── SELECT ───────────────────────────────────────────────────
    if (t === 'select') {
      const el = elementMap[action.index];
      if (!el) return { ok: false, error: `No element ${action.index}` };
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setter ? setter.call(el, action.value) : (el.value = action.value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }

    if (t === 'wait') {
      await sleep(action.ms || 800);
      return { ok: true };
    }

    return { ok: true };
  }

  // ── Message listener ──────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ pong: true }); return;
    }
    if (msg.type === 'GET_ELEMENTS') {
      sendResponse({ elements: getInteractiveElements() }); return;
    }
    if (msg.type === 'EXEC_ACTION') {
      execAction(msg.action).then(r => sendResponse(r));
      return true;
    }
    if (msg.type === 'GET_PAGE_INFO') {
      sendResponse({
        url:     location.href,
        title:   document.title,
        scrollY: window.scrollY,
        innerH:  window.innerHeight,
        totalH:  document.body.scrollHeight,
      });
      return;
    }
  });

})();