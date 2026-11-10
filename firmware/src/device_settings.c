/* SPDX-License-Identifier: GPL-3.0-only */
/* Main-loop settings transaction. Needs the settings pack/store hooks,
 * flash_ok, boot_safe, patches_up and ui_dirty. */
/* DEVICE_SETTINGS: empty reads; 17 bytes set name[16] and return percent.
 * Reply status, name[16], percent, physical serial[16]. Save before replying. */
static int m1_device_settings(const uint8_t *p, uint32_t n, uint8_t *out)
{
    uint8_t status=0;
    if (n) {
        if (n!=17 || p[16]>100 || !di_valid_name(p)) status=1;
        else if (!flash_ok || boot_safe || !patches_up) status=6;
        else {
            char old[17]; uint8_t level=di_level, set[SET_LEN];
            for (uint32_t i=0;i<17;i++) old[i]=di_name[i];
            for (uint32_t i=0;i<16;i++) di_name[i]=(char)p[i];
            di_name[16]=0; di_level=p[16]; settings_pack(set);
            if (store_write(SL_SETTINGS,0,set,SET_LEN)) {
                for (uint32_t i=0;i<17;i++) di_name[i]=old[i];
                di_level=level; status=6;
            }
            ui_dirty=1;
        }
    }
    out[0]=status;
    for (uint32_t i=0;i<16;i++) { out[1+i]=(uint8_t)di_name[i]; out[18+i]=di_serial[i]; }
    out[17]=di_level;
    return 34;
}
