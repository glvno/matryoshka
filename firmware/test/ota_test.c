// SPDX-License-Identifier: GPL-3.0-only
/* Host test of the update check in ota.c (ota_stage, steps 1-2): the device side of an update session run against the
 * real packages, with a simulated flash and a simulated host answering its read requests. Covers the size check and
 * the head check, including Matryoshka's change for M-VAVE Official Open (#183): a shorter flash.bin passes only with
 * M-VAVE's loader and a head equal to the device's; the head is never replaced by another. Also the head read (cmd 0x12,
 * #264) that tells a host which head the device has.
 *   tools/ota_test.sh */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define FELUCCA_ID "FM-1_712"

static uint8_t flash[0x100000];
static uint8_t *img;                     /* the logical image the host serves */
static uint32_t img_len;
static uint8_t pend[700];                /* the reply waiting for ota_frame_get (7-bit bytes between F0 and F7) */
static uint32_t pend_n, now, committed;
static uint32_t addrs[64], naddr;
static uint8_t head_reply[80];           /* the last cmd 0x12 answer (decoded), head_n its length */
static uint32_t head_n;

static int ota_wire_send(const uint8_t *p, uint32_t n);
static int ota_frame_get(const uint8_t **p, uint32_t *n) { if (!pend_n) return 0; *p = pend; *n = pend_n; return 1; }
static void ota_frame_done(void) { pend_n = 0; }
static uint32_t ota_now_ms(void) { return now++; }
static void ota_idle(void) {}
static int ota_erase(uint32_t off) { memset(flash + off, 0xFF, 0x1000); return 0; }
static int ota_prog(uint32_t off, const void *p, uint32_t n)
{
    const uint8_t *s = p;
    for (uint32_t i = 0; i < n; i++)
        flash[off + i] &= s[i];
    return 0;
}
static int ota_fread(uint32_t off, void *p, uint32_t n) { memcpy(p, flash + off, n); return 0; }
static void ota_show(uint32_t step, int32_t code) { (void)step; (void)code; }
static void ota_commit(const uint8_t *parm) { (void)parm; committed = 1; }

#ifdef __APPLE__
#define section(s) used                   /* Mach-O takes no ".pool" section: the buffers are plain statics here */
#endif
#include "../src/ota.c"
#ifdef __APPLE__
#undef section
#endif

/* the host: answers a read request (cmd 0x30) from the image, the check step's finish address with "success" */
static int ota_wire_send(const uint8_t *p, uint32_t n)
{
    uint8_t m[96], r[540];
    uint32_t d = ota_unpack7(p + 1, n - 2u, m, sizeof m), addr, len, i, s = 0;
    if (d <= sizeof head_reply && d >= 7u && m[2] == 0x12) {
        memcpy(head_reply, m, d);
        head_n = d;
        return 0;
    }
    if (d < 15u || m[2] != 0x30)
        return 0;
    addr = ota_rd32(m + 7);
    len = ota_rd16(m + 11);
    if (naddr < 64u)
        addrs[naddr++] = addr;
    r[0] = 0, r[1] = 0x59, r[2] = 0x30;
    r[3] = (uint8_t)(len + 8u), r[4] = (uint8_t)((len + 8u) >> 8), r[5] = 0, r[6] = 0;
    ota_wr32(r + 7, addr);
    r[11] = (uint8_t)len, r[12] = (uint8_t)(len >> 8), r[13] = 0;
    for (i = 0; i < len; i++)
        r[14 + i] = addr == 0xE0000000u ? (uint8_t)"success"[i < 7u ? i : 7u]   /* "success" and its NUL */
                  : addr + i < img_len ? img[addr + i] : 0xFFu;
    for (i = 6; i < 14u + len; i++)
        s += r[i];
    r[14 + len] = (uint8_t)~s;
    pend_n = ota_pack7(r, 15u + len, pend);
    return 0;
}

static uint8_t *load(const char *path, uint32_t *n)           /* a .fwsc -> its logical image (marker bytes out) */
{
    FILE *f = fopen(path, "rb");
    uint8_t *raw, *out;
    long sz;
    uint32_t i, o = 0;
    if (!f) { perror(path); exit(2); }
    fseek(f, 0, SEEK_END);
    sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    raw = malloc((size_t)sz);
    if (fread(raw, 1, (size_t)sz, f) != (size_t)sz) { perror(path); exit(2); }
    fclose(f);
    out = malloc((size_t)sz);
    for (i = 0; i < (uint32_t)sz; i++)
        if (!(i < 20u * 0x30u && i % 0x30u == 0x2Fu))
            out[o++] = raw[i];
    free(raw);
    *n = o;
    return out;
}

/* a copy whose flash.bin entry claims another length (the header and entry list re-sealed as M-VAVE's packer does) */
static uint8_t *with_flash_len(const uint8_t *src, uint32_t n, uint32_t fl_len)
{
    uint8_t *c = malloc(n), h[0x40];
    uint32_t nent, i;
    memcpy(c, src, n);
    memcpy(h, c, 0x40);
    ota_jl_enc(h, 0x40);
    nent = ota_rd16(h + 8);
    for (i = 0; i < nent; i++) {
        uint8_t *e = c + 0x40 + i * 0x50u;
        ota_jl_enc(e, 0x50);
        if (ota_rd16(e) == 0)
            ota_wr32(e + 12, fl_len);
        ota_jl_enc(e, 0x50);
    }
    ota_wr16(h + 2, ota_crc16(c + 0x40, nent * 0x50u, 0));
    ota_wr16(h, ota_crc16(h + 2, 0x3E, 0));
    ota_jl_enc(h, 0x40);
    memcpy(c, h, 0x40);
    return c;
}

static uint32_t fl_off_of(const uint8_t *im)              /* where flash.bin sits in the image */
{
    uint8_t hdr[0x400];
    uint32_t nent, i, fo = 0;
    memcpy(hdr, im, sizeof hdr);
    ota_jl_enc(hdr, 0x40);
    nent = ota_rd16(hdr + 8);
    for (i = 0; i < nent; i++) {
        uint8_t *e = hdr + 0x40 + i * 0x50u;
        ota_jl_enc(e, 0x50);
        if (ota_rd16(e) == 0)
            fo = ota_rd32(e + 8);
    }
    return fo;
}

static int fails;

/* a stand-in for Official Open's head (M-VAVE's bytes are not in the repository): any other 16 KB */
static void open_like_head(uint8_t *h)
{
    uint32_t y;
    for (y = 0; y < 0x4000u; y++)
        h[y] = (uint8_t)(y * 7u + 3u);
}

/* one update session: the device holds `head` (0x0000-0x3FFF) */
static void run(const char *what, uint8_t *im, uint32_t n, const uint8_t *head, int want)
{
    int rc, staged;
    memset(flash, 0xFF, sizeof flash);
    memcpy(flash, head, 0x4000);
    img = im, img_len = n, naddr = 0, committed = 0, pend_n = 0, now = 0;
    rc = ota_session();
    staged = flash[OTA_AREA] != 0xFFu || flash[OTA_RES] != 0xFFu;
    if (rc != want || (want == 0) != (committed && staged) || (want && staged)) {
        printf("FAIL %s: rc %d (want %d), committed %u, staging area %s\n", what, rc, want, committed, staged ? "written" : "empty");
        fails++;
        return;
    }
    if (want == -5 && !(naddr >= 4u && addrs[0] == 0 && addrs[1] == 512u && addrs[naddr - 1] < addrs[2])) {
        printf("FAIL %s: -5, but the reads are not the pattern the installers recognise\n", what);
        fails++;
        return;
    }
    printf("ok   %s: %s\n", what, rc ? (rc == -5 ? "refused (-5), nothing erased" : "refused (-15), nothing erased") : "staged and committed");
}

/* the host asks for 64 bytes of the head at `off` (cmd 0x12); -> 1 if it got exactly those bytes, 0 if no answer */
static int head_read(uint32_t off)
{
    uint8_t q[9] = {0, 0x59, 0x12, 2, 0, 0, (uint8_t)off, (uint8_t)(off >> 8), 0}, s;
    s = (uint8_t)~(q[6] + q[7]);
    q[8] = s;
    pend_n = ota_pack7(q, 9, pend);
    head_n = 0;
    ota_service();
    if (!head_n)
        return 0;
    return head_n == 73u && ota_rd24(head_reply + 3) == 66u && ota_rd16(head_reply + 6) == off &&
           !memcmp(head_reply + 8, flash + off, 64);
}

static void head_reads(const uint8_t *head)
{
    uint32_t off, all = 1;
    memset(flash, 0xFF, sizeof flash);
    memcpy(flash, head, 0x4000);
    for (off = 0; off < 0x4000u; off += 64u)
        all &= (uint32_t)head_read(off);
    if (!all || head_read(0x4000u) || head_read(0x20u) || head_read(0xFFC0u)) {
        printf("FAIL head read: %s\n", all ? "answered outside the head or off the 64-byte grid" : "wrong bytes");
        fails++;
        return;
    }
    printf("ok   head read: the whole head, nothing outside it\n");
}

int main(int argc, char **argv)
{
    static uint8_t v15_head[0x4000], open_head[0x4000], other_head[0x4000], mat_head[0x4000];
    uint32_t vn, mn;
    uint8_t *v15, *mat, *open14, *open12;
    if (argc < 3) {
        fprintf(stderr, "usage: ota_test FM-1_015.fwsc matryoshka.fwsc [M-VAVE Official Open .fwsc]\n");
        return 2;
    }
    v15 = load(argv[1], &vn);
    mat = load(argv[2], &mn);
    memcpy(v15_head, v15 + fl_off_of(v15), 0x4000);
    memcpy(mat_head, mat + fl_off_of(mat), 0x4000);
    if (argc > 3) {                                     /* M-VAVE's own Official Open, when a copy is at hand */
        uint32_t on;
        uint8_t *o = load(argv[3], &on);
        memcpy(open_head, o + fl_off_of(o), 0x4000);
        run("M-VAVE's own Official Open over its own head", o, on, open_head, 0);
        run("M-VAVE's own Official Open over V15's head", o, on, v15_head, -5);
    } else {
        open_like_head(open_head);
    }
    memcpy(other_head, v15_head, sizeof other_head);
    other_head[0x1234] ^= 0x5A;
    /* Official Open stand-ins: the V15 package with Open's flash.bin size and Open's head */
    open14 = with_flash_len(v15, vn, 0x73000u);
    memcpy(open14 + fl_off_of(open14), open_head, 0x4000);
    open12 = with_flash_len(v15, vn, 0x6F000u);
    memcpy(open12 + fl_off_of(open12), open_head, 0x4000);

    /* the size check */
    run("M-VAVE loader, flash.bin larger than this board's", with_flash_len(v15, vn, 0x94000u), vn, v15_head, -15);
    run("M-VAVE loader, flash.bin not whole sectors", with_flash_len(v15, vn, 0x73001u), vn, v15_head, -15);
    run("M-VAVE loader, flash.bin no longer than the head", with_flash_len(v15, vn, 0x4000u), vn, v15_head, -15);
    run("Matryoshka's own package", mat, mn, other_head, 0);
    run("Matryoshka's loader, a shorter flash.bin", with_flash_len(mat, mn, 0x73000u), mn, mat_head, -15);
    /* the head check: package x device head; the head is only ever rewritten with the same bytes */
    run("V15 over V15's head", v15, vn, v15_head, 0);
    run("V15 over Open's head", v15, vn, open_head, -5);
    run("V15 over another head", v15, vn, other_head, -5);
    run("Open (V14 size) over Open's head", open14, vn, open_head, 0);
    run("Open (V12 size) over Open's head", open12, vn, open_head, 0);
    run("Open over V15's head", open14, vn, v15_head, -5);
    run("Open over another head", open14, vn, other_head, -5);
    head_reads(v15_head);
    if (!fails)
        printf("ota test passed\n");
    return fails ? 1 : 0;
}
