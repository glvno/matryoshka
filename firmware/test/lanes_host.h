/* SPDX-License-Identifier: GPL-3.0-only */
/* The second core's double on the host (#271, after Sloop's tests/cpu1_host.c): engine.c's lane hooks, chosen by
 * HOST_CORES at the first call:
 *   unset or 0  no second core: core 0 renders every part in order (the device without core 1)
 *   1           the job deferred and run inline at the wait (a reordering test). When core 0 waits for the second
 *               core's progress inside the job (a two-core schedule, #802), it finds the job given up (eng_lane_poll)
 *               and renders lane 1 itself; the job then never runs
 *   2           a POSIX thread, as the device's second core: both lanes at once (with HOST_CHAOS=N, random delays up to
 *               N microseconds before and inside each job and before each item of a schedule, to shake out races;
 *               build with -fsanitize=thread to check)
 * HOST_LOST=K: the K-th job is lost (never run, the wait gives up), as a second core given up: core 0 renders the lane.
 * Include before engine.c. */
#pragma once
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <unistd.h>
#define ENG_LANE_HOOKS 1

static int lh_mode = -1, lh_chaos;
static long lh_lost = -1, lh_jobs;
static void (*lh_fn)(uint32_t);
static uint32_t lh_arg;
static pthread_t lh_thread;
static pthread_mutex_t lh_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t lh_cv = PTHREAD_COND_INITIALIZER;
static int lh_posted, lh_done, lh_skip;
static __thread unsigned lh_seed = 12345u;     /* (each thread's own) */

static void lh_jitter(void)
{
    if (lh_chaos > 0)
        usleep((useconds_t)(rand_r(&lh_seed) % (unsigned)lh_chaos));
}
static __attribute__((unused)) void lh_item(void)   /* before an item of a schedule: now and then a shorter delay */
{
    if (lh_chaos > 0 && rand_r(&lh_seed) % 16u == 0u)
        usleep((useconds_t)(rand_r(&lh_seed) % (unsigned)(lh_chaos / 4 + 1)));
}

static void *lh_main(void *unused)
{
    (void)unused;
    for (;;) {
        void (*fn)(uint32_t);
        uint32_t arg;
        pthread_mutex_lock(&lh_mu);
        while (!lh_posted)
            pthread_cond_wait(&lh_cv, &lh_mu);
        fn = lh_fn;
        arg = lh_arg;
        pthread_mutex_unlock(&lh_mu);
        lh_jitter();
        fn(arg);
        pthread_mutex_lock(&lh_mu);
        lh_posted = 0;
        lh_done = 1;
        pthread_cond_broadcast(&lh_cv);
        pthread_mutex_unlock(&lh_mu);
    }
    return 0;
}

static void lh_init(void)
{
    const char *m = getenv("HOST_CORES"), *c = getenv("HOST_CHAOS"), *l = getenv("HOST_LOST");
    lh_mode = m ? atoi(m) : 0;
    lh_chaos = c ? atoi(c) : 0;
    lh_lost = l ? atol(l) : -1;
    if (lh_mode == 2)
        pthread_create(&lh_thread, 0, lh_main, 0);
}

static int eng_lane_run(void (*fn)(uint32_t), uint32_t arg)
{
    if (lh_mode < 0)
        lh_init();
    if (lh_mode == 0)
        return 0;
    lh_skip = lh_jobs++ == lh_lost;
    lh_fn = fn;
    lh_arg = arg;
    if (lh_mode == 2 && !lh_skip) {
        pthread_mutex_lock(&lh_mu);
        lh_done = 0;
        lh_posted = 1;
        pthread_cond_broadcast(&lh_cv);
        pthread_mutex_unlock(&lh_mu);
        lh_jitter();
    }
    return 1;
}

static __attribute__((unused)) int eng_lane_poll(void)
{
    int done;
    if (lh_skip || lh_mode == 1) {
        lh_skip = 1;
        return -1;
    }
    pthread_mutex_lock(&lh_mu);
    done = lh_done;
    pthread_mutex_unlock(&lh_mu);
    return done;
}

static int eng_lane_wait(void)
{
    if (lh_skip)
        return -1;
    if (lh_mode == 1) {
        lh_fn(lh_arg);
        return 0;
    }
    pthread_mutex_lock(&lh_mu);
    while (!lh_done)
        pthread_cond_wait(&lh_cv, &lh_mu);
    pthread_mutex_unlock(&lh_mu);
    return 0;
}
#define ENG_LANE_ITEM() lh_item()
