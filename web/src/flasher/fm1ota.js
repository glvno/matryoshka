// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// The FM-1 USB-MIDI update protocol over WebMIDI (after tools/fm1_install.py).
// Step 1: the running firmware (official
// or Felucca) reads parts of the package and stages the update loader. Step 2:
// the loader reads the whole image and writes it. Both steps are "the device
// asks, we answer": cmd 0x30 read requests on the logical image.

const HS_QUERY = [0xF0, 0x00, 0x32, 0x45, 0x00, 0x00, 0x00, 0x40, 0x7F, 0xF7];
const UPGRADE = [0xF0, 0x22, 0x24, 0x35, 0x7F, 0xF7];
const MAXDATA = 512;
const FINISH_CHECK = 0xE0000000, FINISH_WRITE = 0xF0000000;
const SUCCESS = [...new TextEncoder().encode("success"), 0];
const SETTLE_MS = 600; // after the finish answer: keep the port and answer repeated finish requests (as M-VAVE's WebUpdate.js)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IS_OTA = (id) => /^ota-/i.test(id.model);

// errors carry a code the pages translate: notfound, model, stopped, noloader, lost, noreturn,
// mismatch (detail: the identity the device reports), badreq, phase, bootcode (bootMismatch)
// Which loader may finish an interrupted write of which package. M-VAVE's loader (ota-FM-1_015)
// writes the flash head (boot code) from the package, so it only ever gets the official V15.
// Felucca-lineage loaders (Felucca FM-1_9XY, ours FM-1_7XY since #79 and FM-1_800 before; three digits) never write the head
// and get every other package; their identity does not follow the package's (ours reports
// ota-FM-1_700 for release builds too). Unknown loaders (M-VAVE Official Open, others) get nothing.
export const STOCK_PRODUCT = "FM-1_015";

// #183: before a package with M-VAVE's loader is staged, the running firmware (ota.c ota_stage, step 2) compares the
// package's flash head (boot code, 0x0000-0x3FFF) with its own, because that loader rewrites the head from the package;
// when they differ it stops answering, erases nothing and shows "update failed -5". No error code reaches the host:
// it sees the entry list (0, 512), the loader's header, head reads below it, then silence. `addrs`: the read requests
// served in the check step, in order.
export function bootMismatch(addrs) {
  return addrs.length >= 4 && addrs[0] === 0 && addrs[1] === 512 && addrs[addrs.length - 1] < addrs[2];
}
export const BOOT_MISMATCH =
  "nothing was changed: the FM-1 refused the official V15 (its screen says update failed -5), because the small piece " +
  "of software that starts it (its boot code) is not V15's; most likely it was set up by M-VAVE's Official Open";
export function loaderFits(loader, product) {
  if (product === STOCK_PRODUCT) return loader === "ota-" + STOCK_PRODUCT;
  return /^ota-FM-1_[789]\d\d$/.test(loader);
}

function fail(code, msg, detail = "") { const e = new Error(msg); e.code = code; e.detail = detail; return e; }

export function pack7(data) {
  const out = []; let acc = 0, nb = 0;
  for (const b of data) {
    acc |= b << nb; nb += 8;
    while (nb >= 7) { out.push(acc & 0x7F); acc >>>= 7; nb -= 7; }
  }
  if (nb) out.push(acc & 0x7F);
  return out;
}

export function unpack7(s) {
  const out = []; let acc = 0, nb = 0;
  for (const b of s) {
    acc |= (b & 0x7F) << nb; nb += 7;
    while (nb >= 8) { out.push(acc & 0xFF); acc >>>= 8; nb -= 8; }
  }
  return out;
}

function response(addr, data, fl = 0) {
  const len = data.length;
  const body = [0x00, 0x59, 0x30, (len + 8) & 0xFF, ((len + 8) >> 8) & 0xFF, 0, fl,
    addr & 0xFF, (addr >>> 8) & 0xFF, (addr >>> 16) & 0xFF, (addr >>> 24) & 0xFF,
    len & 0xFF, (len >> 8) & 0xFF, 0, ...data];
  let s = 0;
  for (let i = 6; i < body.length; i++) s += body[i];
  body.push(~s & 0xFF);
  return [0xF0, ...pack7(body), 0xF7];
}

function parseRequest(pkt) {
  if (pkt[0] !== 0xF0 || pkt[pkt.length - 1] !== 0xF7) return null;
  const u = unpack7(pkt.slice(1, -1));
  if (u.length !== 15 || u[0] !== 0 || u[1] !== 0x59 || u[2] !== 0x30) return null;
  let s = 0;
  for (let i = 6; i < 14; i++) s += u[i];
  if ((~s & 0xFF) !== u[14]) return null;
  return { fl: u[6], addr: (u[7] | (u[8] << 8) | (u[9] << 16) | (u[10] << 24)) >>> 0, len: u[11] | (u[12] << 8) | (u[13] << 16) };
}

function parseIdentity(pkt) {
  const d = unpack7(pkt.slice(1, -1));
  if (d.length !== 34 || d[0] !== 0 || d[1] !== 0x59 || d[2] !== 0x11) return null;
  const txt = String.fromCharCode(...d.slice(6, 33)).replace(/\0+$/, "");
  const m = /^([^_]+)_(\d+)$/.exec(txt);
  return m ? { text: txt, model: m[1], version: parseInt(m[2], 10) } : null;
}

// one MIDI in/out pair with a SysEx queue
class Link {
  constructor(input, output) {
    this.input = input; this.output = output; this.q = []; this.waiter = null;
    // a listener of its own, not onmidimessage: the editor's live link and the MIDI keyboard may use the same port
    this.onmsg = (ev) => {
      if (ev.data[0] !== 0xF0) return;
      this.q.push(Array.from(ev.data));
      if (this.waiter) { const w = this.waiter; this.waiter = null; w(); }
    };
    input.addEventListener("midimessage", this.onmsg);
  }
  get lost() { return this.input.state === "disconnected" || this.output.state === "disconnected"; }
  // false when the port is gone (unplugged): WebMIDI throws on a disconnected output
  send(bytes) {
    try { this.output.send(bytes); return true; } catch (_) { return false; }
  }
  drain() { this.q.length = 0; }
  async read(ms) {
    if (!this.q.length) {
      let tm;
      await Promise.race([new Promise((r) => { this.waiter = r; }), new Promise((r) => { tm = setTimeout(r, ms); })]);
      clearTimeout(tm);
      this.waiter = null;
    }
    return this.q.shift() || null;
  }
  close() { this.input.removeEventListener("midimessage", this.onmsg); }
}

async function handshake(link, tries = 3) {
  link.drain();
  for (let t = 0; t < tries; t++) {
    if (!link.send(HS_QUERY)) return null;
    const end = Date.now() + 1000;
    while (Date.now() < end) {
      const p = await link.read(end - Date.now());
      if (!p) break;
      const id = parseIdentity(p);
      if (id) return id;
    }
  }
  return null;
}

export class Updater {
  constructor(access, log) {
    this.access = access;
    this.log = log || (() => {});
  }

  // every in/out pair with the same port name that answers the handshake
  async find(filter) {
    const outs = [...this.access.outputs.values()];
    for (const input of this.access.inputs.values()) {
      if (input.state === "disconnected") continue;
      if (!/fm-1|felucca|matryoshka|modular|ota|composite|sinco|usb-midi/i.test(input.name || "")) continue;   // never probe other gear
      const output = outs.find((o) => o.name === input.name && o.state !== "disconnected");
      if (!output) continue;
      try { await input.open(); await output.open(); } catch (_) { continue; }
      const link = new Link(input, output);
      const id = await handshake(link, 2);
      if (id && (!filter || filter(id))) return { link, id, name: input.name };
      link.close();
    }
    return null;
  }

  async waitFor(filter, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const dev = await this.find(filter);
      if (dev) return dev;
      await sleep(1000);
    }
    return null;
  }

  // serve read requests until the device asks for the finish address of this phase (M-VAVE's WebUpdate.js is the
  // model: a finish request must be this phase's address and 8 bytes long, anything else is refused, and repeated
  // finish requests are answered for SETTLE_MS); stops early when the port disappears (lost: true) instead of waiting
  // out idleMs
  async serve(link, image, finishAddr, idleMs, onProgress) {
    let served = 0, last = Date.now();
    const addrs = [];
    for (;;) {
      const pkt = await link.read(1000);
      if (!pkt) {
        if (link.lost) return { served, finished: false, lost: true, addrs };
        if (Date.now() - last > idleMs) return { served, finished: false, addrs };
        continue;
      }
      const r = parseRequest(pkt);
      if (!r) continue;
      last = Date.now();
      if (r.len === 0 || r.len > MAXDATA) throw fail("badreq", `bad request length ${r.addr.toString(16)}+${r.len}`);
      if (r.addr === FINISH_CHECK || r.addr === FINISH_WRITE) {
        if (r.addr !== finishAddr || r.len !== SUCCESS.length) throw fail("phase", `finish request ${r.addr.toString(16)}+${r.len} in the ${finishAddr === FINISH_CHECK ? "check" : "write"} step`);
        link.send(response(r.addr, SUCCESS, r.fl));
        await this.settle(link, finishAddr);
        return { served, finished: true, addrs };
      }
      if (r.addr + r.len > image.length) throw fail("badreq", `bad request ${r.addr.toString(16)}+${r.len}`);
      await sleep(10);
      if (!link.send(response(r.addr, Array.from(image.subarray(r.addr, r.addr + r.len)), r.fl))) {
        return { served, finished: false, lost: true, addrs };
      }
      served++;
      addrs.push(r.addr);
      if (onProgress) onProgress(served, r.addr);
    }
  }

  // the answer may still sit in the send queue and the device may ask again: answer the same finish request only
  async settle(link, finishAddr) {
    const end = Date.now() + SETTLE_MS;
    while (Date.now() < end && !link.lost) {
      const pkt = await link.read(Math.min(100, end - Date.now()));
      const r = pkt && parseRequest(pkt);
      if (r && r.addr === finishAddr && r.len === SUCCESS.length) link.send(response(r.addr, SUCCESS, r.fl));
    }
  }

  // full install: running firmware -> loader -> new firmware
  async install(image, product, onStep) {
    const step = onStep || (() => {});
    const dev = await this.find((id) => !IS_OTA(id));
    if (!dev) throw fail("notfound", "FM-1 not found (USB cable, and no other app using it?)");
    const [model] = product.split("_");
    if (dev.id.model !== model) { dev.link.close(); throw fail("model", `the device is ${dev.id.text}, the package is for ${product}`); }
    step("start", dev.id.text);
    dev.link.send(UPGRADE);
    await sleep(2000);
    const s1 = await this.serve(dev.link, image, FINISH_CHECK, 8000, (n) => step("verify", n));
    dev.link.close();
    if (!s1.finished && !s1.lost && product === STOCK_PRODUCT && bootMismatch(s1.addrs)) throw fail("bootcode", BOOT_MISMATCH);
    if (!s1.finished) throw fail(s1.lost ? "lost" : "stopped", `the device ${s1.lost ? "was disconnected" : "stopped"} after ${s1.served} requests: nothing was written`);
    step("loader");
    await sleep(3000);
    const ota = await this.waitFor((id) => id.model === "ota-" + model, 30000);
    if (!ota) throw fail("noloader", "the update loader did not appear. Replug the USB cable and press Install again: the device stays in update mode until it is finished.");
    if (!loaderFits(ota.id.text, product)) { ota.link.close(); throw fail("otherloader", `the loader ${ota.id.text} must not be given ${product}`, ota.id.text); }
    const s2 = await this.write(ota, image, step);
    if (!s2.finished) throw fail(s2.lost ? "lost" : "stopped", `the loader ${s2.lost ? "was disconnected" : "stopped"} after ${s2.served} requests. Replug and press Install again to resume.`);
    step("reboot");
    await sleep(3000);
    const back = await this.waitFor((id) => !IS_OTA(id), 40000);
    if (!back) throw fail("noreturn", "the device did not come back: power-cycle it");
    back.link.close();
    if (back.id.text !== product) throw fail("mismatch", `installed, but the device reports ${back.id.text}`, back.id.text);
    step("done", back.id.text);
    return back.id.text;
  }

  // step 2 with the loader found by find()/waitFor()
  async write(ota, image, step) {
    ota.link.send(UPGRADE);
    await sleep(2000);
    const s2 = await this.serve(ota.link, image, FINISH_WRITE, 180000, (n) => step("write", n));
    ota.link.close();
    return s2;
  }

  // resume: the device is already in update mode (loader) -> true when the write finished.
  // Only a loader that may write this package is fed (loaderFits); any other loader is refused,
  // never written to: M-VAVE's own loader rewrites the flash head with whatever it is given.
  async resume(image, onStep, product) {
    const model = product.split("_")[0];
    const ota = await this.find(IS_OTA);
    if (!ota) return false;
    if (!loaderFits(ota.id.text, product)) {
      ota.link.close();
      throw fail("otherloader", `the FM-1 waits in the update loader ${ota.id.text}, which must not be given ${product}`, ota.id.text);
    }
    const step = onStep || (() => {});
    const result = await this.write(ota, image, step);
    if (!result.finished) return false;
    if (product) {
      step("reboot");
      await sleep(3000);
      const back = await this.waitFor((id) => id.model === model, 40000);
      if (!back) throw fail("noreturn", "The FM-1 did not return after resuming the write.");
      back.link.close();
      if (back.id.text !== product) throw fail("mismatch", "The FM-1 reports a different firmware after resuming.", back.id.text);
      step("done", back.id.text);
    }
    return true;
  }
}
