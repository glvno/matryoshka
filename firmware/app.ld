/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments */
/* FELUCCA memory map.
 * Code + constants execute in place from XIP (app.bin offset 0 = 0x02000120).
 * 0x01C00000..0x01C07F00 holds .ram_text (code that must run while the flash is busy: the flash driver) and after it
 * .lowram (#273: SRAM Felucca kept for a RAM-run debug build we do not have, 0x01C06000..0x01C08000, plus what
 * .ram_text leaves of its 24 KiB; as sloop-fm1 did). crt0.S writes the SPL's state at 0x01C07F20: the region stops at
 * 0x01C07F00. main.c proves .lowram word by word and zeroes it at boot (lowram_prove), tools/build.py reports it.
 * RAM  : .data/.bss (24 KiB): what the audio and key-scan interrupts touch, small variables
 * POOL : big zero-initialised buffers (FX lines, canvases, the parts' engine memory, the main loop's work
 *        buffers), section .pool. The same SRAM: the RAM / POOL boundary only splits the budget (1.5: 96 / 336
 *        KiB -> 24 / 408 KiB: the four voices' state and buffers live in the pool); tools/build.py reads both lengths from here
 * STACKS with 256-byte guard bands; NOINIT survives resets and UBOOT entry. Main stack 20,224 B, supervisor stack 7,936 B;
 *        both painted at boot and their deepest use reported (#273: main.c stack_paint, DIAG page 124). Below the guard band
 *        under the main stack, 4 KiB for the second core (#271, hal/fm1_cpu1.h): its user stack (3,584 B; it guards its
 *        own lowest 256 B) and its supervisor stack (512 B, exceptions only). The main stack gave them up: it held at
 *        most 2,764 B on the test FM-1 (D-373).
 * .c1_text, right after .ram_text: the second core's waiting loop (hal/fm1_cpu1.h fm1_c1_main), in RAM so that an idle
 *        core 1 never fetches from the flash; the PC limit for RAM code covers both (_rt_start.._c1_end, fm1_guard.h).
 * 0x01C7FD50.. is reserved: boot_info, boot-state mailbox, vector table. */
MEMORY
{
    XIP    (rx)  : ORIGIN = 0x02000120, LENGTH = 0x8DFBC
    RAMTEXT (rwx): ORIGIN = 0x01C00000, LENGTH = 0x7F00
    RAM    (rwx) : ORIGIN = 0x01C08000, LENGTH = 24K
    POOL   (rw)  : ORIGIN = 0x01C0E000, LENGTH = 0x66000
    NOINIT (rwx) : ORIGIN = 0x01C7C000, LENGTH = 0x3D50
}
SECTIONS
{
    .text : { KEEP(*(.text.crt0)) *(.text*) *(.rodata*) . = ALIGN(4); _etext = .; } > XIP
    .ram_text : { _rt_start = .; KEEP(*(.ram_text*)) . = ALIGN(4); _rt_end = .; } > RAMTEXT AT > XIP
    _rt_load = LOADADDR(.ram_text);
    .c1_text : { . = ALIGN(4); _c1_start = .; KEEP(*(.c1_text*)) . = ALIGN(4); _c1_end = .; } > RAMTEXT AT > XIP
    _c1_load = LOADADDR(.c1_text);
    .lowram (NOLOAD) : { . = ALIGN(4); _lr_start = .; *(.lowram*) . = ALIGN(4); _lr_end = .; } > RAMTEXT
    _lr_limit = ORIGIN(RAMTEXT) + LENGTH(RAMTEXT);
    .data : { . = ALIGN(4); _data_start = .; *(.data*) *(.sdata*) . = ALIGN(4); _data_end = .; } > RAM AT > XIP
    _data_load = LOADADDR(.data);
    .bss (NOLOAD) : { _bss_start = .; *(.bss*) *(.sbss*) *(COMMON) . = ALIGN(4); _bss_end = .; } > RAM
    .pool (NOLOAD) : { _pool_start = .; *(.pool*) . = ALIGN(4); _pool_end = .; } > POOL
    .noinit (NOLOAD) : { *(.noinit*) } > NOINIT
    /* (spike) hot engine code (engine.c ENG_FAST) in the rest of NOINIT, copied from its load address at every boot
     * (main.c fm1_cstart), so what the boot ROM leaves there does not matter. Within a call's reach (+-4 MiB) of the
     * code in XIP; the RAM below 0x01C80000 - 4 MiB is not. */
    .fast_text : { . = ALIGN(4); _ft_start = .; KEEP(*(.fast_text*)) . = ALIGN(4); _ft_end = .; } > NOINIT AT > XIP
    _ft_load = LOADADDR(.fast_text);
    _c1_ustack = 0x01C74000; _c1_ustack_top = 0x01C74E00; _c1_sstack_top = 0x01C75000;
    _guard0 = 0x01C75000; _ustack_lo = 0x01C75100; _ustack_top = 0x01C7A000;
    _guard1 = 0x01C7A000; _sstack_lo = 0x01C7A100; _sstack_top = 0x01C7C000;
    /DISCARD/ : { *(.comment) *(.note*) }
}
