/* SPDX-License-Identifier: GPL-3.0-only */
/* The FM-1's SPI NOR flash chips (JEDEC id from 9Fh: maker, type, capacity), both 1 MiB with the same commands:
 * the Puya P25Q80H (85 60 14) of the first units, and the UCUN UC25HQ80 (B3 60 14) of units sold since autumn 2026
 * (#739; UC25HQ80 datasheet V1.2, table 8.0). Any other answer: no storage, no updates (main.c flash_ok). */
#pragma once

#define FL_JEDEC_PUYA 0x856014u
#define FL_JEDEC_UCUN 0xB36014u
#define FL_JEDEC_OK(id) ((id) == FL_JEDEC_PUYA || (id) == FL_JEDEC_UCUN)
