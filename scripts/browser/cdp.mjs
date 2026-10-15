// Small CDP helper for driving the local app in headless Edge.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
export async function launch(port, outDir, width = 1100, height = 1400) {
  const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--window-size=${width},${height}`, `--user-data-dir=${outDir}\\prof${port}-${Date.now()}`, 'about:blank'], { stdio: 'ignore' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let targets;
  for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.length) break; } catch {} await sleep(250); }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? (r.result?.exceptionDetails ? 'EXC ' + JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text) : undefined); };
  const api = {
    sleep, send, ev,
    goto: async (url, wait = 2200) => { await send('Page.navigate', { url }); await sleep(wait); },
    text: (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.innerText`),
    click: (scope, label) => ev(`(() => { const b=[...document.querySelectorAll(${JSON.stringify(scope)})].find(x=>x.textContent.includes(${JSON.stringify(label)})); if(!b) return 'NOT FOUND: ${label}'; b.click(); return 'clicked'; })()`),
    set: (sel, value) => ev(`(() => { const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'NOT FOUND'; e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'set'; })()`),
    shot: async (name) => { const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); writeFileSync(`${outDir}\\${name}.png`, Buffer.from(r.result.data, 'base64')); },
    close: () => { try { ws.close(); } catch {} edge.kill(); },
  };
  await send('Page.enable');
  await send('Page.bringToFront');
  return api;
}
