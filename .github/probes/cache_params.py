"""One-variable probe: snapshot voice-loop parameters after preparation. No arithmetic/routing changes."""
from pathlib import Path
import re,sys
p=Path(sys.argv[1]);s=p.read_text();cut=s.index('    AOT_ORACLE_HIT(c);')+len('    AOT_ORACLE_HIT(c);');head=s[:cut];body=s[cut:]
alias={'gi':29,'ob':30,'oa':31,'filter':35};decl={}
def cache(m,param):
 key=f'q{m}_{param.lower()}'
 decl.setdefault(key,f'    const int32_t {key} = EF(c->it[{m}], {param});')
 return key
def direct(match):
 obj,param=match.groups();m=int(obj[6:-1]) if obj.startswith('c->it[') else alias[obj]
 return cache(m,param)
body=re.sub(r'EF\((c->it\[\d+\]|gi|ob|oa|filter), (\w+)\)',direct,body)
def scale(match):
 m=int(match[1]);return f'oracle_scale_q({cache(m,"SCALE_P_GAIN")}, {cache(m,"SCALE_P_OFFSET")}, '
def vca(match):
 m=int(match[1]);return f'oracle_vca_q({cache(m,"VCA_P_GAIN")}, '
def select(match):
 m=int(match[1]);on=f'q{m}_on';val=f'q{m}_value'
 decl.setdefault(on,f'    const int32_t {on} = c->k[{m}] == 1;')
 decl.setdefault(val,f'    const int32_t {val} = EF(c->it[{m}], SELECT_P_V1 + c->k[{m}]);')
 return f'oracle_select_q({on}, {val}, '
body=re.sub(r'oracle_scale\(c, (\d+), ',scale,body)
body=re.sub(r'oracle_vca\(c, (\d+), ',vca,body)
body=re.sub(r'oracle_select\(c, (\d+), ',select,body)
helpers='''static inline int32_t oracle_scale_q(int32_t gain, int32_t offset, int32_t x) { return mul16(x,gain)+offset; }
static inline int32_t oracle_vca_q(int32_t gain, int32_t x, int32_t cv) { return mul16(mul16(x,cv),gain); }
static inline int32_t oracle_select_q(int32_t on, int32_t value, int32_t x) { return (on ? x : 0)+value; }

'''
head=head.replace('static int aot_oracle_voice(aot_cx_t *c)',helpers+'static int aot_oracle_voice(aot_cx_t *c)')
p.write_text(head+'\n    /* Probe: prepared parameters are block-constant. */\n'+'\n'.join(decl.values())+body)
print(f'cached {len(decl)} values')
