# SPDX-License-Identifier: GPL-3.0-only
# #271: compare rig_cpu_survey.py runs against a one-core run of the same firmware: the steady audio ISR time (the median of
# the samples after the first) per phase, mean / best / worst change, and the 8-key column per factory patch.
#   python3 tools/rig_core1_compare.py BASE.json RUN.json [RUN.json ...]
import json, sys, statistics as S
a = {r['name']: r for r in json.load(open(sys.argv[1]))}
xs = {f.rsplit('/', 1)[-1].replace('.json', ''): {r['name']: r for r in json.load(open(f))} for f in sys.argv[2:]}
tags = list(xs)
def st(r, k): s = sorted(r[k][1:]); return s[len(s) // 2]
for k in ('n0_samples', 'n1_samples', 'n4_samples', 'n8_samples'):
    for t, x in xs.items():
        rs = [(st(x[n], k) / st(a[n], k), n) for n in x if n in a and st(a[n], k) > 300]
        r = [v for v, _ in rs]; mx = max(rs); mn = min(rs)
        print(k, t, f"mean {100*(S.mean(r)-1):+.1f} %  best {100*(mn[0]-1):+.1f} ({mn[1]})  worst {100*(mx[0]-1):+.1f} ({mx[1]})")
print(f"{'patch':16} base8 " + " ".join(f"{t[-12:]:>12}" for t in tags))
for n in a:
    print(f"{n:16} {st(a[n], 'n8_samples'):>5} " + " ".join(f"{st(x[n], 'n8_samples'):>12}" for x in xs.values() if n in x))
