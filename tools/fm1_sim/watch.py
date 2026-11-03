#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""A naive-owner session live, for a person watching (the "headed" run): a page that shows each new screen with the
action, the player's prediction and what was heard, newest first. Serves build/fm1_sim/sessions/.
  tools/fm1_sim/watch.py [PORT]   then open http://localhost:PORT/ (default 8765)"""
import http.server, os, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "build", "fm1_sim", "sessions"))
os.makedirs(ROOT, exist_ok=True)
PAGE = b"""<!doctype html><meta charset=utf-8><title>FM-1 naive owner</title>
<style>body{font:15px system-ui;margin:16px;background:#111;color:#ddd}img{width:480px;image-rendering:pixelated;border:1px solid #444}
.s{display:flex;gap:16px;margin-bottom:18px}.t b{color:#fff}.x{color:#9cf}.h{color:#fc9}.d{color:#8f8;font-size:18px}</style>
<div id=done></div><div id=log>Waiting for the player to start...</div>
<script>
let seen=-1;
async function tick(){
  try{
    const r=await fetch('latest/log.jsonl?'+Date.now()); if(!r.ok) return;
    const lines=(await r.text()).trim().split('\\n').filter(Boolean).map(JSON.parse);
    if(lines.length!==seen){ seen=lines.length;
      document.getElementById('log').innerHTML=lines.slice().reverse().map(e=>{
        const a=Object.assign({},e.args), x=a.expect||''; delete a.expect;
        return `<div class=s><img src="latest/${e.screen}">`+(e.settled?`<img src="latest/${e.settled}" title="a moment later">`:'')+`<div class=t><b>step ${e.step}: ${e.tool}</b> ${Object.entries(a).map(([k,v])=>k+'='+v).join(' ')}`+
          (x?`<p class=x>expects: ${x}</p>`:'')+(e.heard?`<p class=h>heard: ${e.heard.replace(/\\n/g,' &middot; ')}</p>`:'')+`</div></div>`}).join('');
    }
    const d=await fetch('latest/done.json?'+Date.now());
    if(d.ok){const j=await d.json();document.getElementById('done').innerHTML=`<p class=d>done (${j.result}): ${j.belief}</p>`}
  }catch(e){}
}
setInterval(tick,500);tick();
</script>"""


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(PAGE)
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass


http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8765), H).serve_forever()
