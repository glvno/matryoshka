// SPDX-License-Identifier: GPL-3.0-only
// The test rig's side of the device test mode (#291), in a page of its own on the dev server (/__rig, dev/rig-page.ts):
// the scripts (scripts/rig.mjs, scripts/device-scenarios.mjs) drive it through Playwright. It finds the FM-1s on Web
// MIDI, tells the registered rig from any other FM-1, and talks to that one alone: the panel (TEST_KEY / TEST_TURN), the
// screen as text (TEST_SCREEN), the output's peak (TEST_PEAK), the draw times (DIAG 120..123), the rig's mark (a preset of RIG_STRUCTURE). Until a rig is
// picked it sends only HELLO and PRESET_GET, which change nothing, so an FM-1 that is not the rig is never driven.
import { CMD, FEATURE_TEST, frame, RIG_PRESET, RIG_STRUCTURE, helloFrame, parse, parseAck, parseInfo, parsePeak, parsePresetData, parseScreen,
  presetGetFrame, presetPutFrame, testKeyFrame, testPeakFrame, testScreenFrame, testTurnFrame, type Info, type Parsed, type ScreenHead,
  type ScreenText } from '../src/protocol';

/** the names an FM-1 shows on USB MIDI (fm1_install.py's family: update loaders too) */
const FM1_NAME = /fm-1|felucca|matryoshka|modular|ota|composite|sinco|usb-midi/i;

export interface Pair { inId: string; outId: string; name: string; info: Info | null }
type Match = (inId: string, p: Parsed) => boolean;

let access: MIDIAccess | null = null;
let pair: { inp: MIDIInput; out: MIDIOutput } | null = null;
const waiters: { match: Match; done: (p: Parsed, inId: string) => void }[] = [];

async function open(): Promise<MIDIAccess> {
  if (access) return access;
  access = await navigator.requestMIDIAccess({ sysex: true });
  for (const inp of access.inputs.values()) {
    if (!FM1_NAME.test(inp.name ?? '')) continue;
    inp.onmidimessage = (ev) => {
      const p = ev.data ? parse(ev.data) : null;
      const w = p ? waiters.findIndex((x) => x.match(inp.id, p)) : -1;
      if (p && w >= 0) waiters.splice(w, 1)[0].done(p, inp.id);
    };
  }
  return access;
}

/** the next frame `match` takes (with the input it came in on), or null after `ms` */
function wait(match: Match, ms: number): Promise<{ p: Parsed; inId: string } | null> {
  return new Promise((res) => {
    const w = { match, done: (p: Parsed, inId: string) => { clearTimeout(t); res({ p, inId }); } };
    const t = setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      res(null);
    }, ms);
    waiters.push(w);
  });
}

/** every FM-1-like output, with the input that answers its HELLO (two FM-1s may carry the same name) */
async function pairs(): Promise<Pair[]> {
  const a = await open();
  const found: Pair[] = [];
  for (const out of a.outputs.values()) {
    if (!FM1_NAME.test(out.name ?? '')) continue;
    const got = wait((inId, p) => p.cmd === CMD.info && !found.some((f) => f.inId === inId), 800);
    out.send(helloFrame());
    const r = await got;
    if (r) found.push({ inId: r.inId, outId: out.id, name: out.name ?? '', info: parseInfo(r.p) });
  }
  return found;
}

/** how many FM-1-like inputs there are (an update loader that does not answer HELLO counts too) */
async function ports(): Promise<number> {
  return [...(await open()).inputs.values()].filter((i) => FM1_NAME.test(i.name ?? '')).length;
}

/** the values of the rig's mark on this FM-1, or null: it is not a rig */
async function markOf(p: Pair): Promise<number[] | null> {
  const out = (await open()).outputs.get(p.outId);
  if (!out) return null;
  const got = wait((inId, x) => inId === p.inId && x.cmd === CMD.presetData, 1500);
  out.send(presetGetFrame(RIG_STRUCTURE, RIG_PRESET));
  const r = await got;
  return r ? parsePresetData(r.p)?.values ?? null : null;
}

async function ask(frame: Uint8Array, match: (p: Parsed) => boolean, ms = 1500): Promise<Parsed> {
  const pr = pair;
  if (!pr) throw new Error('no rig picked');
  const got = wait((inId, p) => inId === pr.inp.id && match(p), ms);
  pr.out.send(frame);
  const r = await got;
  if (!r) throw new Error('the rig did not answer');
  return r.p;
}
async function acked(frame: Uint8Array, cmd: number, tries = 3): Promise<void> {
  const a = parseAck(await retry(() => ask(frame, (p) => p.cmd === CMD.ack && p.payload[0] === cmd, 2000), tries));
  if (!a || a.status !== 0) throw new Error(`the rig refused command ${cmd.toString(16)} (status ${a?.status})`);
}
/** again when no answer came: while the editor uploads a patch the FM-1 can be slow to answer, or miss a frame */
async function retry<T>(f: () => Promise<T>, tries = 3): Promise<T> {
  for (let k = 1; ; k++) {
    try {
      return await f();
    } catch (e) {
      if (k >= tries || !/did not|came short/.test(String(e))) throw e;
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const rig = {
  ports,
  pairs,
  markOf,
  /** this pair is the rig from now on; it must have the device test mode */
  async pick(p: Pair): Promise<void> {
    const a = await open();
    const inp = a.inputs.get(p.inId), out = a.outputs.get(p.outId);
    if (!inp || !out) throw new Error('that FM-1 is gone');
    if (!p.info || !(p.info.features & FEATURE_TEST)) throw new Error('the rig runs a firmware without the device test mode (#291): install one first');
    pair = { inp, out };
  },
  /** write the rig's mark (scripts/rig.mjs register, with one FM-1 connected) */
  async mark(p: Pair, values: number[]): Promise<void> {
    const out = (await open()).outputs.get(p.outId);
    if (!out) throw new Error('that FM-1 is gone');
    const got = wait((inId, x) => inId === p.inId && x.cmd === CMD.ack && x.payload[0] === CMD.presetPut, 3000);
    out.send(presetPutFrame(RIG_STRUCTURE, RIG_PRESET, values));
    const r = await got;
    const ack = r ? parseAck(r.p) : null;
    if (!ack || ack.status !== 0) throw new Error(`the FM-1 did not store the mark (status ${ack?.status ?? 'no answer'})`);
  },
  key: (id: number, down: boolean): Promise<void> => acked(testKeyFrame(id, down), CMD.testKey),   // (held or not: safe to send again)
  async tap(id: number, hold = 80): Promise<void> {
    await rig.key(id, true);
    await sleep(hold);
    await rig.key(id, false);
  },
  turn: (enc: number, clicks: number): Promise<void> => acked(testTurnFrame(enc, clicks), CMD.testTurn, 1),   // (once: a lost ACK must not turn twice)
  /** the screen as text: the head, then the texts in reading order */
  screen: (): Promise<ScreenHead & { texts: ScreenText[] }> => retry(screenOnce),
  /** DIAG page n (bring-up diagnostics; 120..123: the LCD's draw times, ui.c ui_time_diag): its bytes after the page */
  async diag(n: number): Promise<number[]> {
    const p = await retry(() => ask(frame(CMD.diag, [n]), (x) => x.cmd === CMD.diagReply && x.payload[0] === n, 2000));
    return [...p.payload.slice(1)];
  },
  /** the output's peak (16 bit) since the last call */
  async peak(): Promise<{ peak: number; running: boolean; muted: boolean; masterDown: boolean }> {
    return parsePeak(await retry(() => ask(testPeakFrame(), (p) => p.cmd === CMD.peak, 2000)))!;
  },
};

async function screenOnce(): Promise<ScreenHead & { texts: ScreenText[] }> {
  const pr = pair;
  if (!pr) throw new Error('no rig picked');
  const isScreen = (head: boolean): Match => (inId, x) => inId === pr.inp.id && x.cmd === CMD.screen && (x.payload[0] === 0xff) === head;
  const first = wait(isScreen(true), 2500);
  pr.out.send(testScreenFrame());
  const h = await first;
  const hs = h ? parseScreen(h.p) : null;
  if (!hs || !('head' in hs)) throw new Error('the rig did not send its screen');
  const texts: ScreenText[] = [];
  for (let k = 0; k < hs.head.count; k++) {
    const r = await wait(isScreen(false), 1500);
    const t = r ? parseScreen(r.p) : null;
    if (!t || !('text' in t)) throw new Error('the rig\'s screen came short');
    texts[t.k] = t.text;
  }
  return { ...hs.head, texts: texts.filter(Boolean) };
}

(window as unknown as { __rig: typeof rig }).__rig = rig;
document.title = 'rig ready';
