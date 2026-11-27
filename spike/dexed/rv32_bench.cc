// SPDX-License-Identifier: Apache-2.0
// Spike #1338: msfa voices on tools/cpu/rv32.mjs's cycle model (the model web/src/cpu-costs.json is counted on). Every
// measured block is one 128-sample render (two msfa 64-sample blocks), between the host calls rv32.mjs counts.
//   blocks, in order: N = 1, 2, 4, 8, 16 voices of SPIKE 1 (8 blocks each, after 8 blocks of attack);
//   then one voice of SPIKE 1 with each algorithm 1..32 (4 blocks each); then one note-on (dxs_note_on alone).
#include <stdint.h>
#include <stddef.h>
#include "core/dxs.h"

static inline long host(long n, long a, long b, long c) {
    register long a0 __asm__("a0") = a, a1 __asm__("a1") = b, a2 __asm__("a2") = c, a7 __asm__("a7") = n;
    __asm__ volatile("ecall" : "+r"(a0) : "r"(a1), "r"(a2), "r"(a7) : "memory");
    return a0;
}

extern "C" void *memset(void *d, int c, size_t n) {
    unsigned char *p = (unsigned char *)d;
    while (n--) *p++ = (unsigned char)c;
    return d;
}
extern "C" void *memcpy(void *d, const void *s, size_t n) {
    unsigned char *p = (unsigned char *)d;
    const unsigned char *q = (const unsigned char *)s;
    while (n--) *p++ = *q++;
    return d;
}

static int32_t out[128];
static const int keys[16] = {48, 52, 55, 59, 60, 64, 67, 71, 72, 76, 79, 83, 84, 88, 91, 95};
static uint8_t v[156] = {
#define OP(ol) 99, 50, 35, 40, 99, 90, 85, 0, 39, 0, 0, 0, 0, 0, 1, 2, ol, 0, 1, 0, 7
    OP(80), OP(80), OP(99), OP(80), OP(80), OP(99),
#undef OP
    99, 99, 99, 99, 50, 50, 50, 50, 0, 6, 1, 35, 0, 10, 20, 0, 0, 3,
    24, 'S', 'P', 'I', 'K', 'E', ' ', '1', ' ', ' ', ' ', 0x3f,
};

static void render(int measured) {
    for (int i = 0; i < 128; i++) out[i] = 0;
    if (measured) host(2, 6, 0, 0);
    dxs_render(out, 128);
    if (measured) host(2, 7, 0, 0);
}

static void silence(int n) {
    for (int i = 0; i < n; i++) dxs_note_off(keys[i]);
    while (dxs_live()) render(0);
}

extern "C" int main(void) {
    static const int counts[5] = {1, 2, 4, 8, 16};
    for (int op = 0; op < 6; op++) v[op * 21 + 3] = 99;   // release rate 99: the voices end within a few blocks
    dxs_init();
    dxs_set_voice(v);
    for (int c = 0; c < 5; c++) {
        for (int i = 0; i < counts[c]; i++) dxs_note_on(keys[i], 100);
        for (int b = 0; b < 8; b++) render(0);
        for (int b = 0; b < 8; b++) render(1);
        silence(counts[c]);
    }
    for (int a = 0; a < 32; a++) {
        v[134] = (uint8_t)a;
        dxs_set_voice(v);
        dxs_note_on(60, 100);
        for (int b = 0; b < 8; b++) render(0);
        for (int b = 0; b < 4; b++) render(1);
        silence(1);
    }
    v[134] = 0;
    dxs_set_voice(v);
    host(2, 6, 0, 0);
    dxs_note_on(60, 100);
    host(2, 7, 0, 0);
    return (int)out[0];
}

extern "C" __attribute__((naked, section(".text.start"))) void _start(void) {
    __asm__ volatile("li sp, 0x00f00000\n call main\n li a7, 93\n ecall\n");
}
