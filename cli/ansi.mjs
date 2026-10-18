/**
 * ansi.mjs — terminal colour constants, defined once, in the layer that prints.
 *
 * WHY THIS IS HERE AND NOT UNDER `lib/`. Measured 2026-08-25 across the whole
 * tree: **zero of 58 `lib/` modules contain an ANSI escape, and none of them
 * print.** `lib/` modules take input and return data; `cli.mjs` and this layer
 * render it. That separation is what let doctor's four sections be extracted
 * and tested as data rather than by capturing stdout and regexing it.
 *
 * Command implementations are the other half of that split: they exist to
 * produce human output, so they need these, and putting them in `lib/` would
 * erode the property rather than express it.
 *
 * `cli.mjs` imports from here too, so there is ONE definition rather than a
 * copy per command module. A second copy is one edit away from being the copy
 * that disagrees — the failure `rule:tool-priority` was written about.
 */

export const RESET = "\x1b[0m";
export const DIM = "\x1b[2m";
export const RED = "\x1b[31m";
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const BOLD = "\x1b[1m";
