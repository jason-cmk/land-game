// Browser smoke test for the board: starts Vite and headless Chrome, then
// plays through the real UI over the DevTools protocol (no extra dependencies):
//   1. a full two-tab match (BroadcastChannel), by clicking and dragging cards
//   2. a tab reloaded mid-game resumes in lockstep
//   3. two tabs connect over real WebRTC with the copy-paste codes and play, then
//      reconnect with fresh codes after a dropped link and after a reload
// Fails on any timeout, lockstep mismatch or console error. Screenshots go to
// smoke-output/.
//
// Usage: npm run smoke   (CHROME_PATH overrides the Chrome binary)
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = `${ROOT}smoke-output`;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGE = 'http://127.0.0.1:5199/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

async function waitHttp(url, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {}
    if (Date.now() > end) throw new Error(`timeout waiting for ${url}`);
    await sleep(200);
  }
}

const vite = spawn('npx', ['vite', '--port', '5199', '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${OUT}/profile`, '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank',
], { stdio: 'ignore' });

let exitCode = 0;
try {
  await waitHttp(PAGE);
  const version = await (await waitHttp('http://127.0.0.1:9333/json/version')).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let nextId = 1;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(`[${msg.sessionId?.slice(0, 4)}] exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
    } else if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
      errors.push(`[${msg.sessionId?.slice(0, 4)}] console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  async function openTab(name) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    await send('Page.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
    await send('Page.navigate', { url: PAGE }, sessionId);
    const tab = {
      name,
      async eval(expression) {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (r.exceptionDetails) throw new Error(`${name}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
        return r.result.value;
      },
      async click(x, y) {
        await send('Page.bringToFront', {}, sessionId);
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
          await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId);
        }
      },
      /** Press at `from`, move in steps to `to`, release; `midway` runs while the card is held. */
      async drag(from, to, midway) {
        await send('Page.bringToFront', {}, sessionId);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y }, sessionId);
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
        const steps = 12;
        for (let k = 1; k <= steps; k++) {
          const x = from.x + ((to.x - from.x) * k) / steps;
          const y = from.y + ((to.y - from.y) * k) / steps;
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 }, sessionId);
          await sleep(25);
          if (k === steps / 2 && midway) await midway();
        }
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
      },
      async shot(file) {
        await send('Page.bringToFront', {}, sessionId);
        await sleep(500);
        const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
        writeFileSync(`${OUT}/${file}`, Buffer.from(data, 'base64'));
      },
    };
    for (let i = 0; i < 50 && (await tab.eval('document.readyState')) !== 'complete'; i++) await sleep(100);
    return tab;
  }

  const state = (tab) => tab.eval(`(() => { const g = window.__landGame; if (!g) return null; const c = g.coordinator;
    return { status: c.status, log: c.log.length, head: c.log.at(-1)?.hash ?? null, outcome: c.outcome, prompt: document.getElementById('prompt').textContent, ...g.clickables() }; })()`);

  async function waitFor(tabs, predicate, ms = 15000, what = 'condition') {
    const end = Date.now() + ms;
    for (;;) {
      const states = await Promise.all(tabs.map(state));
      if (predicate(states)) return states;
      if (Date.now() > end) throw new Error(`timeout: ${what}: ${JSON.stringify(states.map((s) => s && { status: s.status, log: s.log, prompt: s.prompt }))}`);
      await sleep(100);
    }
  }

  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;

  /** Play by clicking whatever the UI offers, until both finish or `limit` moves. */
  async function playByClicking(tabs, limit, tag) {
    let cardClicks = 0;
    let cardDrags = 0;
    let buttonClicks = 0;
    let peerSawDrag = false;
    for (let moves = 0; moves < limit; moves++) {
      const states = await Promise.all(tabs.map(state));
      if (states.every((s) => s.status === 'over')) break;
      const i = states.findIndex((s) => s.cards.length > 0 || s.buttons.some((b) => b !== 'Resign'));
      if (i === -1) {
        await sleep(100);
        moves--;
        continue;
      }
      const tab = tabs[i];
      const s = states[i];
      const buttons = s.buttons.filter((b) => b !== 'Resign' && b !== 'Cancel' && b !== 'New match');
      const useCard = s.cards.length > 0 && (buttons.length === 0 || rand() < 0.8);
      const before = s.log;
      if (useCard) {
        const card = s.cards[Math.floor(rand() * s.cards.length)];
        // Clicks hit cards where they are drawn: wait until nothing is still gliding (a freshly
        // shuffled-in card's neighbours slide across it) or held by an effect.
        for (let waited = 0; (await tab.eval('window.__landGame.settling()')) > 1; waited += 50) {
          if (waited > 4000) throw new Error(`${tag}: the table never settled`);
          await sleep(50);
        }
        if (s.kind === 'main' && rand() < 0.5) {
          // Drag it onto the middle of the table; the other tab should see it move.
          const middle = await tab.eval(`(() => { const r = document.getElementById('table').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
          const peer = tabs[1 - i];
          await tab.drag(card, middle, async () => {
            if (peerSawDrag) return;
            for (let k = 0; k < 10 && !peerSawDrag; k++) {
              peerSawDrag = (await peer.eval('window.__landGame.peerPresence().drag')) !== null;
              if (!peerSawDrag) await sleep(30);
            }
          });
          cardDrags++;
        } else {
          await tab.click(card.x, card.y);
          cardClicks++;
        }
      } else if (buttons.length > 0) {
        const label = buttons[Math.floor(rand() * buttons.length)];
        await tab.eval(`[...document.querySelectorAll('#buttons button')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);
        buttonClicks++;
      }
      // Either the move went through (log grows) or a card pick opened targeting (prompt changes).
      await waitFor(tabs, (now) => now[i].log > before || now[i].kind !== s.kind || now.every((x) => x.status === 'over'), 5000, `${tag} move ${moves}`);
      if (moves === 12) for (const t of tabs) await t.shot(`${tag}-mid-${t.name}.png`);
    }
    if (cardDrags > 0 && !peerSawDrag) throw new Error(`${tag}: the opponent never saw a drag`);
    return { cardClicks, cardDrags, buttonClicks };
  }

  // --- Two tabs over BroadcastChannel ------------------------------------------------
  log('== two tabs (BroadcastChannel)');
  const a = await openTab('seat1');
  const b = await openTab('seat2');
  await a.shot('lobby.png');
  await a.eval(`document.querySelector('button[value="0"]').click()`);
  await sleep(300);
  await b.eval(`document.querySelector('button[value="1"]').click()`);
  await waitFor([a, b], (s) => s.every((x) => x?.status === 'playing'), 15000, 'both playing');
  for (const t of [a, b]) await t.shot(`tabs-start-${t.name}.png`);
  const clicks = await playByClicking([a, b], 600, 'tabs');
  const end = await waitFor([a, b], (s) => s.every((x) => x.status === 'over'), 20000, 'match over');
  for (const t of [a, b]) await t.shot(`tabs-end-${t.name}.png`);
  log('clicks', clicks);
  log('final', end.map((s) => ({ status: s.status, log: s.log, outcome: s.outcome, prompt: s.prompt })));
  log('heads equal', end[0].head === end[1].head);
  if (end[0].head !== end[1].head || end.some((s) => s.outcome?.kind !== 'win')) throw new Error('two-tab match did not finish in agreement');

  // --- Reload mid-game (two tabs) ----------------------------------------------------
  log('== reload a tab mid-game');
  const c = await openTab('r1');
  const d = await openTab('r2');
  await c.eval(`document.getElementById('room').value = 'reload'; document.querySelector('button[value="0"]').click()`);
  await sleep(300);
  await d.eval(`document.getElementById('room').value = 'reload'; document.querySelector('button[value="1"]').click()`);
  await waitFor([c, d], (s) => s.every((x) => x?.status === 'playing'), 15000, 'reload: both playing');
  await playByClicking([c, d], 10, 'reload');
  const beforeReload = await state(d);
  await d.eval(`location.reload()`);
  await sleep(800);
  await d.eval(`document.getElementById('room').value = 'reload'; document.querySelector('button[value="1"]').click()`);
  const afterReload = await waitFor([c, d], (s) => s.every((x) => x?.status === 'playing') && s[0].head === s[1].head, 15000, 'reload: resynced');
  log('reload: log before', beforeReload.log, 'after', afterReload[1].log, 'heads equal', afterReload[0].head === afterReload[1].head);
  await playByClicking([c, d], 10, 'reload-after');
  const reloadEnd = await Promise.all([c, d].map(state));
  log('reload: still in lockstep after more moves', reloadEnd[0].head === reloadEnd[1].head, reloadEnd.map((s) => s.status));
  if (reloadEnd[0].head !== reloadEnd[1].head) throw new Error('reloaded tab fell out of lockstep');

  // --- Online (real WebRTC between two headless tabs) ----------------------------------
  log('== online (WebRTC)');
  const e = await openTab('inviter');
  const f = await openTab('joiner');
  await e.eval(`document.getElementById('invite').click()`);
  const invite = await (async () => {
    for (let i = 0; i < 100; i++) {
      const v = await e.eval(`document.getElementById('code').value`);
      if (v) return v;
      await sleep(100);
    }
    throw new Error('no invite code');
  })();
  log('invite code length', invite.length);
  await f.eval(`document.getElementById('invite-code').value = ${JSON.stringify(invite)}; document.getElementById('join').click()`);
  const reply = await (async () => {
    for (let i = 0; i < 100; i++) {
      const v = await f.eval(`document.getElementById('code').value`);
      if (v) return v;
      await sleep(100);
    }
    throw new Error('no reply code');
  })();
  log('reply code length', reply.length);
  await e.shot('online-invite.png');
  await e.eval(`document.getElementById('reply-code').value = ${JSON.stringify(reply)}; document.getElementById('accept').click()`);
  await waitFor([e, f], (s) => s.every((x) => x?.status === 'playing'), 20000, 'webrtc: both playing');
  await playByClicking([e, f], 25, 'online');
  const online = await waitFor([e, f], (s) => s[0].head === s[1].head, 10000, 'webrtc: heads converge');
  log('online: log', online.map((s) => s.log), 'heads equal', online[0].head === online[1].head);
  for (const t of [e, f]) await t.shot(`online-${t.name}.png`);

  /** Poll an expression in a tab until it is truthy. */
  async function poll(tab, expression, what, ms = 20000) {
    const end = Date.now() + ms;
    for (;;) {
      const value = await tab.eval(expression);
      if (value) return value;
      if (Date.now() > end) throw new Error(`timeout: ${what}`);
      await sleep(100);
    }
  }
  /** Swap reconnect codes: `inviter` makes a code in its panel, `joiner` answers it in its own. */
  async function swapCodes(inviter, inviterPanel, joiner, joinerPanel) {
    const button = (panel, text) => `[...document.querySelectorAll('${panel} button')].find((b) => b.textContent === ${JSON.stringify(text)})`;
    await inviter.eval(`${button(inviterPanel, 'Make a reconnect code')}.click()`);
    const code = await poll(inviter, `document.querySelector('${inviterPanel} textarea[readonly]')?.value`, 'reconnect code');
    await joiner.eval(`(() => { document.querySelector('${joinerPanel} textarea').value = ${JSON.stringify(code)}; ${button(joinerPanel, 'Use their code')}.click(); })()`);
    const reply = await poll(joiner, `document.querySelector('${joinerPanel} textarea[readonly]')?.value`, 'reconnect reply');
    await inviter.eval(`(() => { const areas = document.querySelectorAll('${inviterPanel} textarea'); areas[areas.length - 1].value = ${JSON.stringify(reply)}; ${button(inviterPanel, 'Connect')}.click(); })()`);
  }

  log('== online: the link drops mid-game');
  await e.eval('window.__landGame.dropLink()');
  for (const t of [e, f]) await poll(t, `!document.getElementById('reconnect').hidden`, `${t.name}: reconnect panel`);
  await f.shot('online-dropped-joiner.png');
  // Seat 2 makes the code this time; the inviter's seat travels in it.
  await swapCodes(f, '#reconnect-panel', e, '#reconnect-panel');
  const relinked = await waitFor([e, f], (s) => s.every((x) => x?.status === 'playing') && s[0].head === s[1].head, 20000, 'drop: resynced');
  for (const t of [e, f]) await poll(t, `document.getElementById('reconnect').hidden`, `${t.name}: panel closes`);
  await playByClicking([e, f], 8, 'online-relinked');
  const afterDrop = await waitFor([e, f], (s) => s[0].head === s[1].head, 10000, 'drop: heads converge');
  log('drop: log', relinked[0].log, '->', afterDrop[0].log, 'heads equal', afterDrop[0].head === afterDrop[1].head);

  log('== online: a tab reloads mid-game');
  if (afterDrop.some((x) => x.status === 'over')) throw new Error('match ended before the reload check; raise the move budget');
  await f.eval('location.reload()');
  await poll(f, `document.readyState === 'complete' && !document.getElementById('resume').hidden`, 'lobby offers to resume');
  await poll(e, `!document.getElementById('reconnect').hidden`, 'peer sees the drop');
  await f.shot('online-resume-lobby.png');
  await swapCodes(f, '#resume-panel', e, '#reconnect-panel');
  const resumed = await waitFor([e, f], (s) => s.every((x) => x?.status === 'playing') && s[0].head === s[1].head, 20000, 'reload: resynced');
  await playByClicking([e, f], 8, 'online-resumed');
  const afterResume = await waitFor([e, f], (s) => s[0].head === s[1].head, 10000, 'reload: heads converge');
  log('reload: log', resumed[1].log, '->', afterResume[1].log, 'heads equal', afterResume[0].head === afterResume[1].head);

  log('== console errors/warnings:', errors.length ? `\n${errors.join('\n')}` : 'none');
  if (errors.length > 0) throw new Error(`${errors.length} console error(s)`);
  log('PASS');
  ws.close();
} catch (err) {
  console.error('FAILED:', err.message);
  exitCode = 1;
} finally {
  chrome.kill();
  vite.kill();
}
process.exit(exitCode);
