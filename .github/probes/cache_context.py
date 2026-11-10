"""Second one-variable probe: snapshot fixed input signals and final output pointer."""
from pathlib import Path
import re,sys
p=Path(sys.argv[1]);s=p.read_text();cut=s.index('    AOT_ORACLE_HIT(c);')+len('    AOT_ORACLE_HIT(c);');head=s[:cut];body=s[cut:]
indices=sorted(set(map(int,re.findall(r'c->x->sh\[(\d+)\]',body))))
for i in indices:body=body.replace(f'c->x->sh[{i}]',f'sh{i}')
body=body.replace('c->it[37]->out[0][i]','final_out[i]')
p.write_text(head+'\n'+''.join(f'    const asig_t sh{i} = c->x->sh[{i}];\n' for i in indices)+'    esig_t *const final_out = c->it[37]->out[0];\n'+body)
