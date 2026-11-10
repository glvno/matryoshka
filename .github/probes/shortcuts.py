"""Isolated offline probes. Input is the parameter+signal snapshot header."""
from pathlib import Path
import sys
p=Path(sys.argv[1]); mode=sys.argv[2]; s=p.read_text()
assert mode in ('zero','unity','constant','combined')
def change(old,new):
    global s
    assert s.count(old)==1, old
    s=s.replace(old,new)
scale='return mul16(x,gain)+offset;'
vca='return mul16(mul16(x,cv),gain);'
if mode in ('zero','combined'):
    change(scale,'if (!gain) return offset; '+scale)
    change(vca,'if (!gain) return 0; '+vca)
if mode in ('unity','combined'):
    change(scale,'if (gain == ENG_ONE) return x+offset; '+scale)
    change(vca,'if (gain == ENG_ONE) return mul16(x,cv); '+vca)
if mode in ('constant','combined'):
    # These graph outputs are uniform even if the shared selector path falls back.
    # Keep x->sh materialized for preparation/worker safety. sh1 can fade: leave it alone.
    for i in (0,2,3,5):
        change(f'const asig_t sh{i} = c->x->sh[{i}];',
               f'const asig_t sh{i} = AU(af_read(c->x->sh[{i}], 0));')
p.write_text(s)
