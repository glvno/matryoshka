/* SPDX-License-Identifier: GPL-3.0-only */
/* Focused native-kernel transitions, independent of generated bank fixtures:
 * cc -std=c11 -O1 -Ifirmware/src firmware/test/fx_tail_test.c -lm -o build/fx-tail-test
 * build/fx-tail-test
 * Integration separately loads the actual format55 stereo graph through eng_load. */
#include <stdio.h>
#include <string.h>
#include "engine.c"

static int fails;
#define CHECK(c, why) do { if (!(c)) { fprintf(stderr, "FAIL: %s\n", why); fails++; } } while (0)
static node_t node;
static inst_t inst;
static int32_t effective[32], input[ENG_BLOCK], left[ENG_BLOCK], right[ENG_BLOCK];
static int16_t line[DELAY_LEN];
static uint32_t kind;

static fx_stage_t *setup(uint32_t type)
{
    uint32_t i;
    kind = type == T_DELAY ? ENG_FX_DELAY : ENG_FX_REVERB;
    memset(&node, 0, sizeof node);
    memset(&inst, 0, sizeof inst);
    memset(&fx, 0, sizeof fx);
    memset(line, 0, sizeof line);
    node.type = (uint8_t)type;
    inst.eff = effective;
    for (i = 0; i < DEFS[type].npar; i++) effective[i] = DEFS[type].pdef[i];
    for (i = 0; i < MAX_IN; i++) inst.in[i] = zero_buf;
    for (i = 0; i < MAX_OUT; i++) inst.out[i] = dummy_out;
    inst.in[DEFS[type].thru] = input;
    inst.out[0] = left;
    if (type == T_DELAY) {
        inst.out[1] = right;
        inst.s.dly.buf = line;
        inst.s.dly.len = DELAY_LEN;
        inst.s.dly.beat = ENG_SR / 2u;
        effective[DELAY_P_TIME] = 30 * ENG_ONE;
        effective[DELAY_P_MIX] = ENG_ONE;
    } else {
        inst.s.rev.buf = line;
        effective[REVERB_P_MIX] = ENG_ONE;
        effective[REVERB_P_MOD] = 0;
    }
    fx.stage[kind].kind = (uint8_t)kind;
    fx.stage[kind].n = 2; /* legacy/general paired stages still return their own dry signal */
    fx.stage[kind].on = 1;
    fx.stage[kind].run[0].gain = FX_RAMP;
    fx.stage[kind].run[0].fade = FX_FULL;
    fx.stage[kind].run[0].tail = 1;
    return &fx.stage[kind];
}

static uint64_t render(uint32_t frames, int32_t value)
{
    uint64_t energy = 0;
    while (frames) {
        uint32_t n = frames > ENG_BLOCK ? ENG_BLOCK : frames, i;
        for (i = 0; i < n; i++) input[i] = value;
        m_fx(&node, &inst, n, 1u + kind * ENG_FX_TARGETS_MAX);
        for (i = 0; i < n; i++) energy += (uint64_t)((int64_t)left[i] * left[i]);
        frames -= n;
    }
    return energy;
}

static void skip_record(void)
{
    uint8_t rec[] = {4, 0, 0, 0, 2, 0, 1, 1, 0, 1, 2, 2, 3, 2, 0, 2, 2, 4, 5, 3, 0, 3, 2, 6, 7};
    uint32_t n;
    CHECK(eng_skip_fx(rec, rec + sizeof rec, ENG_FLAG_FX_BUS) == rec + sizeof rec, "bounded FX record accepted");
    CHECK(eng_skip_fx(rec, rec, 0) == rec, "absent record consumes nothing");
    for (n = 0; n < sizeof rec; n++) CHECK(!eng_skip_fx(rec, rec + n, ENG_FLAG_FX_BUS), "every truncated FX record rejected");
    rec[24] = 0;
    CHECK(!eng_skip_fx(rec, rec + sizeof rec, ENG_FLAG_FX_BUS), "overlapping stereo targets rejected");
    rec[24] = 7; rec[19] = 2;
    CHECK(!eng_skip_fx(rec, rec + sizeof rec, ENG_FLAG_FX_BUS), "out-of-order kind rejected");
    rec[19] = 3; rec[23] = ENG_MAX_MODULES;
    CHECK(!eng_skip_fx(rec, rec + sizeof rec, ENG_FLAG_FX_BUS), "out-of-range target rejected");
    {
        uint8_t sparse[] = {2, ENG_FX_CHORUS, 0, 0, 2, 1, 2, ENG_FX_REVERB, 0, 1, 1, 3};
        uint8_t single[] = {1, ENG_FX_REVERB, 0, 0, 1, 3};
        CHECK(eng_skip_fx(sparse, sparse + sizeof sparse, ENG_FLAG_FX_BUS) == sparse + sizeof sparse, "ordered sparse actual kinds accepted");
        CHECK(eng_skip_fx(single, single + sizeof single, ENG_FLAG_FX_BUS) == single + sizeof single, "single wet Reverb record accepted");
        for (n = 0; n < sizeof sparse; n++)
            CHECK(!eng_skip_fx(sparse, sparse + n, ENG_FLAG_FX_BUS), "sparse record truncations rejected");
        sparse[7] = ENG_FX_CHORUS;
        CHECK(!eng_skip_fx(sparse, sparse + sizeof sparse, ENG_FLAG_FX_BUS), "duplicate sparse kind rejected");
        sparse[7] = ENG_FX_STAGE_COUNT;
        CHECK(!eng_skip_fx(sparse, sparse + sizeof sparse, ENG_FLAG_FX_BUS), "unknown sparse kind rejected");
        single[0] = 0;
        CHECK(!eng_skip_fx(single, single + sizeof single, ENG_FLAG_FX_BUS), "empty FX record rejected");
        single[0] = ENG_FX_STAGE_COUNT + 1u;
        CHECK(!eng_skip_fx(single, single + sizeof single, ENG_FLAG_FX_BUS), "oversized FX record rejected");
    }
}

int main(void)
{
    fx_stage_t *stage;
    uint32_t i;
    skip_record();
    stage = setup(T_DELAY);
    effective[DELAY_P_FB] = 0;
    render(4096, ENG_ONE / 8);
    stage->on = 0;
    CHECK(render(1024, ENG_ONE / 8) > (uint64_t)1024 * (ENG_ONE / 8) * (ENG_ONE / 8), "Delay spills existing wet signal over a dry transition");
    render(4096, ENG_ONE / 8);
    for (i = 0; i < ENG_BLOCK; i++) CHECK(left[i] == ENG_ONE / 8 && right[i] == ENG_ONE / 8, "off Delay admits no new input to either tap");

    stage = setup(T_DELAY);
    effective[DELAY_P_TIME] = 500 * ENG_ONE;
    effective[DELAY_P_FB] = 58982; /* 0.9 */
    render(ENG_SR, ENG_ONE / 8);
    stage->on = 0;
    render(2u * ENG_SR, 0);
    CHECK(render(ENG_SR, 0) > 100000u, "ordinary Delay decay continues beyond the forced-tail bound");
    CHECK(stage->run[0].fade == FX_FULL, "natural tail is not forcibly faded");

    for (uint32_t type = T_DELAY, pass = 0; pass < 2; pass++, type = T_REVERB) {
        stage = setup(type);
        if (type == T_DELAY) {
            effective[DELAY_P_SWELL] = ENG_ONE;
            effective[DELAY_P_FB] = 62259; /* 0.95 */
        }
        render(ENG_SR, ENG_ONE / 8);
        if (type == T_REVERB) effective[REVERB_P_FREEZE] = ENG_ONE;
        stage->on = 0;
        CHECK(render(4096, 0) > 0, "forced tail spills before it fades");
        CHECK(stage->run[0].tail == 2u && stage->run[0].fade > 0u && stage->run[0].fade < FX_FULL,
              "a sustaining tail takes the two-second fade, not the quiet-window end");
        render(2u * ENG_SR, 0);
        CHECK(!stage->run[0].tail && !render(ENG_BLOCK, 0), "sustaining tail ends within two seconds");
        CHECK(effective[type == T_DELAY ? DELAY_P_SWELL : REVERB_P_FREEZE] == ENG_ONE, "forced fade leaves saved swell/freeze unchanged");
        stage->on = 1; stage->run[0].tail = 1;
        CHECK(!render(4096, 0), "ON does not resurrect the cleared forced tail");
    }
    {
        uint64_t wet[2];
        for (uint32_t pass = 0; pass < 2; pass++) {
            stage = setup(T_REVERB);
            stage->n = 1;
            stage->on = 0; stage->run[0].tail = 0;
            CHECK(!render(4096, ENG_ONE / 8), "fully OFF mono wet branch returns zero, never mono dry");
            stage->on = 1; stage->run[0].tail = 1;
            render(ENG_SR, ENG_ONE / 8);
            stage->on = 0;
            wet[pass] = render(ENG_SR, pass ? ENG_ONE / 4 : 0);
            CHECK(wet[pass] > 0 && stage->run[0].fade == FX_FULL, "single Reverb spills its natural wet tail without a forced fade");
        }
        CHECK(wet[0] == wet[1], "OFF wet branch rejects new input throughout its natural tail");
        stage = setup(T_REVERB);
        stage->n = 1;
        render(ENG_SR, ENG_ONE / 8);
        stage->run[0].gain = 32u;
        stage->on = 0;
        CHECK(render(ENG_BLOCK, 0) > 0 && stage->run[0].gain == 32u, "a partly enabled wet tail retains its ramp level instead of jumping or cutting");
        stage = setup(T_REVERB);
        stage->n = 1;
        render(ENG_SR, ENG_ONE / 8);
        effective[REVERB_P_FREEZE] = ENG_ONE;
        stage->on = 0;
        CHECK(render(4096, ENG_ONE / 8) > 0, "single frozen Reverb starts with wet spillover");
        render(2u * ENG_SR, ENG_ONE / 8);
        CHECK(!stage->run[0].tail && !render(4096, ENG_ONE / 8), "bounded single Reverb returns zero even with nonzero OFF input");
        CHECK(effective[REVERB_P_MIX] == ENG_ONE && effective[REVERB_P_FREEZE] == ENG_ONE, "wet-only wrapper preserves saved kernel controls");
        stage->on = 1; stage->run[0].tail = 1;
        CHECK(!render(4096, 0), "single Reverb ON never resurrects a cleared frozen tail");
    }
    {
        /* A natural OFF tail stops costing once it is silent for a whole line: the kernel no longer runs. */
        uint32_t blocks;
        stage = setup(T_DELAY);
        effective[DELAY_P_TIME] = 290 * ENG_ONE;
        effective[DELAY_P_FB] = 19661; /* 0.3 */
        effective[DELAY_P_MIX] = 19661;
        render(ENG_SR, ENG_ONE / 4);
        stage->on = 0;
        stage->run[0].gain = 0; /* the stereo pair's dry ramp is done */
        CHECK(render(DELAY_LEN - ENG_BLOCK, 0) > 0 && stage->run[0].tail == 1u, "Delay keeps its tail for at least one silent line");
        for (blocks = 0; stage->run[0].tail && blocks < 3u * ENG_SR / ENG_BLOCK; blocks++) render(ENG_BLOCK, 0);
        CHECK(!stage->run[0].tail, "a silent natural Delay tail ends within three seconds");
        CHECK(stage->run[0].clr == (DELAY_LEN + FX_CLEAR_STEP - 1u) / FX_CLEAR_STEP, "an ended tail only marks its line for clearing");
        render(ENG_BLOCK, ENG_ONE / 8);
        for (i = 0; i < ENG_BLOCK; i++) CHECK(left[i] == ENG_ONE / 8 && right[i] == ENG_ONE / 8, "an ended Delay tail is exactly dry");
        CHECK(stage->run[0].clr == (DELAY_LEN + FX_CLEAR_STEP - 1u) / FX_CLEAR_STEP - 1u, "each OFF block clears one step of the line");
        render(ENG_SR, ENG_ONE / 8);
        CHECK(!inst.s.dly.w && !inst.s.dly.cur, "an ended Delay tail's kernel no longer runs");
        for (i = 0; i < DELAY_LEN; i++) CHECK(!line[i], "an ended Delay tail leaves a clear line");
        CHECK(effective[DELAY_P_FB] == 19661 && effective[DELAY_P_MIX] == 19661, "ending a tail leaves saved controls unchanged");

        stage = setup(T_DELAY);
        effective[DELAY_P_TIME] = 500 * ENG_ONE;
        effective[DELAY_P_FB] = 58982; /* 0.9: its rounding holds echoes above the silence threshold */
        effective[DELAY_P_MIX] = 19661;
        render(ENG_SR, ENG_ONE / 4);
        stage->on = 0;
        stage->run[0].gain = 0;
        render(10u * ENG_SR, 0);
        CHECK(stage->run[0].tail == 1u && render(ENG_SR, 0) > 0, "an audible natural tail is never ended");

        stage = setup(T_REVERB);
        stage->n = 1;
        effective[REVERB_P_SIZE] = 43254; /* 0.66 */
        effective[REVERB_P_DAMP] = 49807; /* 0.76 */
        effective[REVERB_P_MIX] = 18350;  /* 0.28 */
        render(ENG_SR, ENG_ONE / 4);
        stage->on = 0;
        CHECK(render(RV_LEN - ENG_BLOCK, 0) > 0 && stage->run[0].tail == 1u, "Reverb keeps its tail for at least one silent memory length");
        for (blocks = 0; stage->run[0].tail && blocks < 3u * ENG_SR / ENG_BLOCK; blocks++) render(ENG_BLOCK, 0);
        CHECK(!stage->run[0].tail, "a silent natural Reverb tail ends within three seconds");
        CHECK(!render(ENG_BLOCK, ENG_ONE / 8), "an ended wet Reverb returns exactly zero");
        CHECK(stage->run[0].clr == (RV_LEN + FX_CLEAR_STEP - 1u) / FX_CLEAR_STEP - 1u, "the Reverb's memory clears one step a block");
        stage->on = 1; stage->run[0].tail = 1; stage->run[0].quiet = 0;
        CHECK(!render(ENG_BLOCK, 0) && !stage->run[0].clr, "ON finishes a pending clear before the kernel runs");
        for (i = 0; i < RV_LEN; i++) CHECK(!line[i], "ON during a pending clear leaves no old tail in the memory");
        CHECK(render(ENG_SR / 4, ENG_ONE / 4) > 0, "ON after an ended tail plays new input");
    }
    printf("fx_tail_test: %s\n", fails ? "FAIL" : "ok");
    return fails ? 1 : 0;
}
