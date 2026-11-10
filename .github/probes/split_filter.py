"""Third ablation: keep cached inputs, split oscillator A/mix and ladder into separate loops."""
from pathlib import Path
import sys
p=Path(sys.argv[1]);s=p.read_text()
needle='        int32_t x20 = (mul16(amix, q47_mixer_p_l1) + mix_b[i]) << 4;'
assert s.count(needle)==1
s=s.replace(needle,'''        pitch_a[i] = mul16(amix, q47_mixer_p_l1) + mix_b[i];
    }
    oracle_osc_end(oa, phase_a, previous_sync);
    for (i = 0; i < n; i++) {
        int32_t x20 = pitch_a[i] << 4;''')
s=s.replace('    oracle_osc_end(oa, phase_a, previous_sync);\n    filter->s.lad.s[0]', '    filter->s.lad.s[0]')
p.write_text(s)
