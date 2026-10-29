/* SPDX-License-Identifier: GPL-3.0-only */
/* Edit a poly group in the running patch. Shared by the device, WebAssembly and panel tests. */
static int poly_patch_set(uint8_t *bin, uint32_t len, uint32_t mod, uint32_t field, int32_t v,
                          int (*reload)(const uint8_t *, uint32_t))
{
    int g = eng_module_group(mod);
    uint32_t at, i;
    uint8_t before[4];
    int rc;
    if (g <= 0 || len < 8u || field >= ENG_NPOLY)
        return -1;
    at = 8u + ENG_GROUP_REC * (uint32_t)(g - 1);
    if (at + 4u > len || (bin[1] < 39u && field == ENG_POLY_UNISON && v > 1) || (bin[1] < 38u && field == ENG_POLY_STACK) || (bin[1] < 37u && (field == ENG_POLY_STEAL || (field == ENG_POLY_ASSIGN && v > 2))))
        return -1;
    for (i = 0; i < 4u; i++)
        before[i] = bin[at + i];
    v = clampi(v, field == ENG_POLY_PARTS ? 1 : 0,
               field == ENG_POLY_PARTS || field == ENG_POLY_STACK ? ENG_MAX_PARTS : field == ENG_POLY_ASSIGN ? 3 : field == ENG_POLY_STEAL ? 1 : 2);
    if (field == 0u)
        bin[at] = (uint8_t)((bin[at] & 0xF0u) | (uint32_t)v);
    else if (field == 1u)
        bin[at + 1u] = (uint8_t)v;
    else if (field == 2u)
        bin[at + 2u] = (uint8_t)((bin[at + 2u] & 0xC0u) | (uint32_t)clampi(v, 0, 2));
    else if (field == 3u)
        bin[at + 3u] = (uint8_t)((bin[at + 3u] & 0x80u) | (uint32_t)v);
    else if (field == 4u)
        bin[at + 2u] = (uint8_t)((bin[at + 2u] & 0x3Fu) | (v ? 0x80u : 0u) | (v == 2 ? 0x40u : 0u));
    else if (field == ENG_POLY_STACK)
        bin[at] = (uint8_t)((bin[at] & 15u) | ((uint32_t)v << 4));
    else
        bin[at + 3u] = (uint8_t)((bin[at + 3u] & 0x7Fu) | (v ? 0u : 0x80u));
    if (field == 0u || field == 4u) {
        rc = reload(bin, len);                  /* a larger group may exhaust a pool */
        if (rc) {
            for (i = 0; i < 4u; i++)
                bin[at + i] = before[i];
            (void)reload(bin, len);             /* eng_load cleared the engine even when it failed */
        }
        return rc;
    }
    if (eng_poly_set((uint32_t)g - 1u, field, (uint32_t)v)) return 0;
    for (i = 0; i < 4u; i++) bin[at + i] = before[i];
    return -1;
}
