// SPDX-License-Identifier: GPL-3.0-only
// The clock out's timer (clock-out.ts), in a worker: a worker's timer keeps its pace while the tab is in the background.
const post = (globalThis as unknown as { postMessage(m: unknown): void }).postMessage.bind(globalThis);
setInterval(() => post(0), 25);
