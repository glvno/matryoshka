/* SPDX-License-Identifier: GPL-3.0-only */
/* Edit a poly group in the running patch. Shared by the device, WebAssembly and panel tests. */
static int poly_patch_set(uint8_t *bin, uint32_t len, uint32_t mod, uint32_t field, int32_t v,
                          int (*reload)(const uint8_t *, uint32_t))
{
    int g = eng_module_group(mod);
    uint32_t at, i;
    uint8_t before[4];
    int rc;
    if (g <= 0 || !len || field > 4u)
        return -1;
    at = 8u + ENG_GROUP_REC * (uint32_t)(g - 1);
    if (at + 4u > len)
        return -1;
    for (i = 0; i < 4u; i++)
        before[i] = bin[at + i];
    if (field == 0u)
        bin[at] = (uint8_t)clampi(v, 1, ENG_MAX_PARTS);
    else if (field == 1u)
        bin[at + 1u] = (uint8_t)clampi(v, 0, 2);
    else if (field == 2u)
        bin[at + 2u] = (uint8_t)((bin[at + 2u] & 0x80u) | (uint32_t)clampi(v, 0, 2));
    else if (field == 3u)
        bin[at + 3u] = (uint8_t)clampi(v, 0, 2);
    else
        bin[at + 2u] = (uint8_t)((bin[at + 2u] & 0x7Fu) | (v ? 0x80u : 0u));
    if (field == 0u || field == 4u) {
        rc = reload(bin, len);                  /* a larger group may exhaust a pool */
        if (rc) {
            for (i = 0; i < 4u; i++)
                bin[at + i] = before[i];
            (void)reload(bin, len);             /* eng_load cleared the engine even when it failed */
        }
        return rc;
    }
    return eng_poly_set((uint32_t)g - 1u, field, (uint32_t)v) ? 0 : -1;
}
