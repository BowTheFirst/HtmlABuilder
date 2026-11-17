#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Proves the Android narrator path works, without a browser or a device.
//
//   node scripts/verify-tts-shim.js [path/to/index.js] [path/to/app.html]
//
// Two independent things are checked:
//
//   A. PLACEMENT. injectTtsShim() must make the shim the FIRST <script> in the
//      document, ahead of any app code that captures window.speechSynthesis.
//      This is the bug that made Written Magic's narrator silent in the APK.
//
//   B. RUNTIME. The shim is executed in a fake Android WebView (dead Chromium
//      speech stub + a fake Nitron Tts plugin) and driven with a manual clock:
//      a stale `const synth = window.speechSynthesis` capture must still speak,
//      word boundaries must arrive, and native events must never be delivered
//      to the wrong utterance.
//
// The shim and the injector are read straight out of index.js, so this test can
// never pass against a different implementation than the one that ships.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const serverPath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'index.js'));
const appPath = process.argv[3] ? path.resolve(process.argv[3]) : null;

let failures = 0, checks = 0;
function ok(label) { checks++; console.log('  ok   ' + label); }
function fail(label, detail) {
  failures++; checks++;
  console.log('  FAIL ' + label + (detail ? '\n       ' + detail : ''));
}
function assert(cond, label, detail) { cond ? ok(label) : fail(label, detail); }
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  assert(a === e, label, 'expected ' + e + ', got ' + a);
}

// ── extract the shipping implementation ──────────────────────────────────────
const server = fs.readFileSync(serverPath, 'utf8');

const SHIM_HEAD = 'const FORGE_TTS_SHIM = `';
const SHIM_TAIL = '\n})();</script>`;';
const s0 = server.indexOf(SHIM_HEAD);
const s1 = server.indexOf(SHIM_TAIL, s0);
if (s0 < 0 || s1 < 0) { console.error('verify-tts-shim: FORGE_TTS_SHIM not found in ' + serverPath); process.exit(2); }
const shimLiteral = server.slice(s0 + SHIM_HEAD.length - 1, s1 + SHIM_TAIL.length - 1); // drop the trailing ';'
const FORGE_TTS_SHIM = vm.runInNewContext('(' + shimLiteral + ')');

const INJ_HEAD = 'function injectTtsShim(html) {';
const INJ_TAIL = '  return { html: injected, anchor, beforeAppScripts: first === shimAt };\n}';
const i0 = server.indexOf(INJ_HEAD);
const i1 = server.indexOf(INJ_TAIL, i0);
if (i0 < 0 || i1 < 0) { console.error('verify-tts-shim: injectTtsShim() not found in ' + serverPath); process.exit(2); }
const injectTtsShim = vm.runInNewContext('(' + server.slice(i0, i1 + INJ_TAIL.length) + ')', { FORGE_TTS_SHIM });

console.log('verify-tts-shim: implementation loaded from ' + path.basename(serverPath));

// ── A. placement ─────────────────────────────────────────────────────────────
console.log('\nA. shim placement');

assert(/^[\x00-\x7F]*$/.test(FORGE_TTS_SHIM),
  'shim is pure ASCII (it is injected before <meta charset>)');

// A fixture that reproduces Written Magic's shape: an early app script that
// captures speechSynthesis, plus a decoy </body> inside a JS template string.
const FIXTURE = [
  '<!DOCTYPE html>', '<html lang="en">', '<head>', '<meta charset="utf-8">',
  '<title>Fixture</title>', '</head>', '<body>',
  '<script id="app-early">const synth = window.speechSynthesis;<\/script>',
  '<script>const tpl = `<html><head></head><body></body></html>`;<\/script>',
  '<script id="wm-narrator">/* narrator */<\/script>',
  '</body>', '</html>'
].join('\n');

const once = injectTtsShim(FIXTURE);
const firstScriptAt = once.html.search(/<script\b/i);
const shimAt = once.html.search(/<script id="forge-android-tts-shim">/i);
const captureAt = once.html.indexOf('const synth = window.speechSynthesis;');
assert(once.beforeAppScripts === true, 'injector reports beforeAppScripts=true');
assert(shimAt === firstScriptAt, 'shim IS the first <script> in the document');
assert(shimAt < captureAt, 'shim runs before the app captures window.speechSynthesis');
eq(once.anchor, 'head', 'anchor chosen');

const twice = injectTtsShim(once.html);
eq((twice.html.match(/<script id="forge-android-tts-shim">/g) || []).length, 1, 're-injecting keeps exactly one shim');
eq(twice.html, once.html, 're-injecting is byte-for-byte idempotent');

// An APK already built with the broken v2 placement must be upgraded, not doubled.
const v2At = FIXTURE.toLowerCase().lastIndexOf('</body>');
const legacy = FIXTURE.slice(0, v2At) + FORGE_TTS_SHIM + FIXTURE.slice(v2At);
const upgraded = injectTtsShim(legacy);
eq((upgraded.html.match(/<script id="forge-android-tts-shim">/g) || []).length, 1, 'a legacy </body> shim is removed, not duplicated');
assert(upgraded.html.search(/<script\b/i) === upgraded.html.search(/<script id="forge-android-tts-shim">/i),
  'legacy </body> shim is relocated ahead of app code');

// No <head>, no <body>, script-only fragments.
const noHead = injectTtsShim('<script>var a=1;<\/script><p>hi</p>');
assert(noHead.beforeAppScripts, 'fragment without <head> still gets the shim first');
const bare = injectTtsShim('<p>no scripts at all</p>');
assert(bare.html.indexOf(FORGE_TTS_SHIM) === 0, 'document with no scripts gets the shim at the very top');

if (appPath && fs.existsSync(appPath)) {
  const real = fs.readFileSync(appPath, 'utf8');
  const out = injectTtsShim(real).html;
  const cap = out.indexOf('window.speechSynthesis');
  const sh = out.search(/<script id="forge-android-tts-shim">/i);
  assert(sh >= 0 && sh === out.search(/<script\b/i), path.basename(appPath) + ': shim is the first script');
  assert(sh < cap, path.basename(appPath) + ': shim precedes every speechSynthesis reference');
} else if (appPath) {
  fail('app HTML not found: ' + appPath);
}

// ── B. runtime in a fake WebView ─────────────────────────────────────────────
console.log('\nB. shim runtime (fake Android WebView + fake Nitron Tts plugin)');

const tick = () => new Promise(r => setImmediate(r));

function makeEnv({ webView = true, deadNative = true } = {}) {
  const timers = new Map(); let seq = 0;
  const dispatched = [];
  const ctx = {
    navigator: { userAgent: webView ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36; wv)' : 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0 Safari/537.36', language: 'en-US' },
    location: { hostname: webView ? 'appassets.androidplatform.net' : 'example.com' },
    console: { warn() {}, log() {}, error() {} },
    setTimeout(fn) { const id = ++seq; timers.set(id, { fn, repeat: false }); return id; },
    setInterval(fn) { const id = ++seq; timers.set(id, { fn, repeat: true }); return id; },
    clearTimeout(id) { timers.delete(id); },
    clearInterval(id) { timers.delete(id); },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    dispatchEvent(ev) { dispatched.push(ev && ev.type); return true; }
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;

  if (deadNative) {
    // Chromium exposes the Web Speech surface in WebView but never synthesises.
    function SpeechSynthesis() {}
    SpeechSynthesis.prototype.speak = function () {
      throw new TypeError("Failed to execute 'speak' on 'SpeechSynthesis': parameter 1 is not of type 'SpeechSynthesisUtterance'.");
    };
    SpeechSynthesis.prototype.cancel = function () {};
    SpeechSynthesis.prototype.pause = function () {};
    SpeechSynthesis.prototype.resume = function () {};
    SpeechSynthesis.prototype.getVoices = function () { return []; };
    Object.defineProperty(SpeechSynthesis.prototype, 'speaking', { get() { return false; }, configurable: true });
    Object.defineProperty(SpeechSynthesis.prototype, 'pending', { get() { return false; }, configurable: true });
    Object.defineProperty(SpeechSynthesis.prototype, 'paused', { get() { return false; }, configurable: true });
    function SpeechSynthesisUtterance(text) { this.text = text; }
    ctx.SpeechSynthesis = SpeechSynthesis;
    ctx.SpeechSynthesisUtterance = SpeechSynthesisUtterance;
    ctx.speechSynthesis = new SpeechSynthesis();
  }

  const sandbox = vm.createContext(ctx);
  return {
    ctx, sandbox, dispatched,
    run(code) { return vm.runInContext(code, sandbox); },
    installShim() { return vm.runInContext(FORGE_TTS_SHIM.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''), sandbox); },
    async drive(n) {
      for (let i = 0; i < n; i++) {
        for (const [id, t] of Array.from(timers)) {
          if (!t.repeat) timers.delete(id);
          if (timers.has(id) || !t.repeat) { try { t.fn(); } catch (e) { /* surfaced via assertions */ } }
        }
        await tick(); await tick(); await tick();
      }
    },
    intervalCount() { let n = 0; for (const t of timers.values()) if (t.repeat) n++; return n; }
  };
}

function makePlugin({ speakDelay = false } = {}) {
  const st = { seq: 0, queue: [], calls: [], lastArgs: null, ready: true, failed: false, deferred: null };
  return {
    st,
    init() { st.calls.push('init'); return Promise.resolve({ ready: st.ready, pending: !st.failed }); },
    speak(args) {
      st.calls.push('speak'); st.lastArgs = args;
      const id = ++st.seq;
      // Native callbacks are fast: events exist before speak() resolves its id.
      st.queue.push({ type: 'start', id }, { type: 'range', id, start: 0, end: 5 }, { type: 'range', id, start: 6, end: 11 }, { type: 'done', id });
      if (speakDelay) return new Promise(res => { st.deferred = () => res({ id }); });
      return Promise.resolve({ id });
    },
    poll() {
      st.calls.push('poll');
      const events = st.queue.splice(0, st.queue.length);
      return Promise.resolve({ ready: st.ready, failed: st.failed, speaking: events.length > 0, events });
    },
    stop() { st.calls.push('stop'); st.queue.length = 0; return Promise.resolve({ stopped: true }); }
  };
}

function attach(env, plugin) {
  env.ctx.Nitron = { plugins: { Tts: plugin } };
}

function recordUtterance(env, text) {
  const seen = [];
  const u = env.run('new window.SpeechSynthesisUtterance(' + JSON.stringify(text) + ')');
  u.onstart = () => seen.push('start');
  u.onboundary = ev => seen.push('boundary@' + ev.charIndex + ':' + ev.charLength);
  u.onend = () => seen.push('end');
  u.onerror = ev => seen.push('error:' + ev.error);
  return { u, seen };
}

(async () => {
  // B1. The exact Written Magic failure: app captured speechSynthesis FIRST.
  {
    const env = makeEnv();
    const stale = env.run('window.speechSynthesis');           // app script runs first
    const plugin = makePlugin();
    attach(env, plugin);
    env.installShim();                                        // shim runs afterwards

    assert(env.ctx.speechSynthesis !== stale, 'B1 window.speechSynthesis was replaced by the facade');
    assert(typeof stale.speak === 'function' && stale.speak === env.ctx.speechSynthesis.speak,
      'B1 the STALE captured object now routes into the facade (in-place hijack)');
    assert(stale.speaking === false, 'B1 stale object exposes the facade speaking getter');

    const { u, seen } = recordUtterance(env, 'hello world');
    stale.speak(u);                                           // narrator speaks via its stale ref
    await env.drive(4);
    eq(seen, ['start', 'boundary@0:5', 'boundary@6:5', 'end'], 'B1 stale reference produces audio + word boundaries + end');
    eq(plugin.st.lastArgs && plugin.st.lastArgs.text, 'hello world', 'B1 native plugin received the text');
    assert(env.ctx.ForgeTts && env.ctx.ForgeTts.version === 3, 'B1 window.ForgeTts diagnostics exposed');
    assert(env.dispatched.indexOf('forge:tts-ready') >= 0, 'B1 forge:tts-ready dispatched');
  }

  // B2. Events that arrive before speak() resolves its id must not be lost.
  {
    const env = makeEnv();
    const plugin = makePlugin({ speakDelay: true });
    attach(env, plugin);
    env.installShim();
    const { u, seen } = recordUtterance(env, 'buffered events');
    env.ctx.speechSynthesis.speak(u);
    await tick(); await tick();
    await env.drive(2);                    // poll drains start/range/done while id is unknown
    eq(seen, [], 'B2 nothing is delivered before the utterance id is known');
    plugin.st.deferred();                  // speak() finally resolves
    await tick(); await tick(); await tick();
    eq(seen, ['start', 'boundary@0:5', 'boundary@6:5', 'end'], 'B2 buffered events are replayed to the right utterance');
  }

  // B3. A stale 'done' from a flushed utterance must not end the new one.
  {
    const env = makeEnv();
    const plugin = makePlugin();
    attach(env, plugin);
    env.installShim();
    const first = recordUtterance(env, 'first chunk');
    env.ctx.speechSynthesis.speak(first.u);
    await tick(); await tick();
    plugin.st.queue.length = 0;                       // drop chunk 1 events
    const second = recordUtterance(env, 'second chunk');
    env.ctx.speechSynthesis.speak(second.u);          // interrupt -> QUEUE_FLUSH
    await tick(); await tick();
    const newId = plugin.st.seq;
    plugin.st.queue.unshift({ type: 'done', id: newId - 1 });  // trailing done from chunk 1
    await env.drive(3);
    assert(second.seen.indexOf('end') >= 0, 'B3 the new utterance ends on its OWN done event');
    assert(first.seen.indexOf('end') < 0, 'B3 the interrupted utterance never receives a bogus end');
    assert(first.seen.indexOf('error:interrupted') >= 0, 'B3 the interrupted utterance is told it was interrupted');
  }

  // B4. cancel() stops polling and clears state.
  {
    const env = makeEnv();
    const plugin = makePlugin();
    attach(env, plugin);
    env.installShim();
    const { u } = recordUtterance(env, 'cancel me');
    env.ctx.speechSynthesis.speak(u);
    await tick();
    env.ctx.speechSynthesis.cancel();
    await tick();
    assert(plugin.st.calls.indexOf('stop') >= 0, 'B4 cancel() calls the native stop');
    assert(env.ctx.speechSynthesis.speaking === false, 'B4 cancel() clears speaking');
    eq(env.intervalCount(), 0, 'B4 cancel() stops the poll interval');
  }

  // B5. Bridge attaches late (slow device): speak() queues, then plays.
  {
    const env = makeEnv();
    env.installShim();                                 // no Nitron bridge yet
    const { u, seen } = recordUtterance(env, 'late bridge');
    env.ctx.speechSynthesis.speak(u);
    await env.drive(2);
    eq(seen, [], 'B5 nothing plays before the bridge exists');
    const plugin = makePlugin();
    attach(env, plugin);
    await env.drive(6);
    eq(seen, ['start', 'boundary@0:5', 'boundary@6:5', 'end'], 'B5 queued speech plays once the bridge attaches');
  }

  // B6. Voice-list gating apps get a voice and a voiceschanged event.
  {
    const env = makeEnv();
    attach(env, makePlugin());
    env.installShim();
    const voices = env.ctx.speechSynthesis.getVoices();
    assert(Array.isArray(voices) && voices.length === 1 && voices[0].default === true, 'B6 getVoices() reports one default system voice');
    let fired = 0;
    env.ctx.speechSynthesis.onvoiceschanged = () => { fired++; };
    env.ctx.speechSynthesis.addEventListener('voiceschanged', () => { fired++; });
    await env.drive(1);
    assert(fired >= 2, 'B6 voiceschanged reaches both onvoiceschanged and addEventListener');
  }

  // B7. A real desktop browser must keep its working Web Speech API untouched.
  {
    const env = makeEnv({ webView: false, deadNative: false });
    const real = { speak() {}, cancel() {}, getVoices() { return [{ name: 'Real' }]; } };
    env.ctx.speechSynthesis = real;
    env.ctx.SpeechSynthesisUtterance = function (t) { this.text = t; };
    env.installShim();
    assert(env.ctx.speechSynthesis === real, 'B7 desktop Chrome keeps the native speechSynthesis');
    assert(!env.ctx.ForgeTts, 'B7 no facade installed in a real browser');
  }

  // B8. Missing TTS engine surfaces a real error instead of hanging silently.
  {
    const env = makeEnv();
    const plugin = makePlugin();
    plugin.st.ready = false; plugin.st.failed = true;
    attach(env, plugin);
    env.installShim();
    const { u, seen } = recordUtterance(env, 'no engine');
    env.ctx.speechSynthesis.speak(u);
    await env.drive(3);
    assert(seen.some(s => s.indexOf('error:') === 0), 'B8 utterance gets an error event when no TTS engine exists');
    assert(env.dispatched.indexOf('forge:tts-error') >= 0, 'B8 forge:tts-error dispatched for diagnostics');
    assert(typeof env.ctx.ForgeTts.lastError === 'string' && env.ctx.ForgeTts.lastError.length > 0, 'B8 ForgeTts.lastError explains the failure');
  }

  console.log('\n' + (failures ? 'FAILED' : 'PASSED') + ': ' + (checks - failures) + '/' + checks + ' checks');
  if (failures) {
    console.error('The Android narrator path is NOT proven. Do not ship this image.');
    process.exit(1);
  }
  console.log('OK: the TTS shim precedes app code and a stale speechSynthesis capture still speaks.');
})().catch(e => { console.error('verify-tts-shim crashed: ' + (e && e.stack || e)); process.exit(1); });
