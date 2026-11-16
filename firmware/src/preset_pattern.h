/* SPDX-License-Identifier: GPL-3.0-only */
/* Factory demonstration patterns are separate from sound values (#833); they come with the factory content (factory.c
 * fc_pattern, #915). */
/* the factory pattern of the structure with the name (in any case) into p: 0 found */
static int preset_pattern_find(uint32_t structure, const char *name, fc_pattern_t *p)
{
    uint32_t i, j;
    for (i = 0; i < fc_npatterns(); i++) {
        if (fc_pattern(i, p) || p->structure != structure)
            continue;
        for (j = 0; name[j] && p->name[j]; j++) {
            uint32_t c = (uint8_t)name[j];
            if (c >= 'a' && c <= 'z') c -= 'a' - 'A';
            if (c != (uint8_t)p->name[j]) break;
        }
        if (!name[j] && !p->name[j]) return 0;
    }
    return -1;
}
/* the factory pattern of the identity into p: 0 found */
static int preset_pattern_identity(uint32_t identity, fc_pattern_t *p)
{
    uint32_t i;
    if (!identity) return -1;
    for (i = 0; i < fc_npatterns(); i++)
        if (!fc_pattern(i, p) && p->identity == identity) return 0;
    return -1;
}
static int preset_pattern_untouched(uint32_t mod, uint32_t pattern, const fc_pattern_t *p)
{
    const uint32_t *words;
    int n, len, rate;
    uint32_t i;
    if (!p || !eng_pattern_has(mod, pattern) || eng_locks_list(mod, pattern, 0, 0) != 0)
        return 0;
    len = eng_pattern_len(mod, pattern);
    rate = eng_pattern_rate(mod, pattern);
    if (!len) len = (eng_get_param(mod, STEPS_P_LEN) + 32768) >> 16;
    if (rate < 0) rate = (eng_get_param(mod, STEPS_P_RATE) + 32768) >> 16;
    if (len != p->len || rate != p->rate || eng_get_param(mod, STEPS_P_SWING) != ((int32_t)p->swing << 16) ||
        eng_get_param(mod, STEPS_P_GATE) != p->gate || eng_get_param(mod, STEPS_P_DIR) != ((int32_t)p->dir << 16))
        return 0;
    n = eng_pattern_notes(mod, pattern, &words);
    if (n != p->n) return 0;
    for (i = 0; i < p->n; i++) if (words[i] != p->notes[i]) return 0;
    return 1;
}
