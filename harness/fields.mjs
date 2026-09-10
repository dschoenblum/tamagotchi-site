/**
 * fields.mjs — the contract between the two sides of the comparison.
 *
 * The oracle (TamaLIB / MAME) can only give us raw 4-bit nibbles. The model
 * holds decoded integers. Comparison happens in RAM space, because that's the
 * ground truth space — so the model's values get ENCODED into nibbles here,
 * and both sides are diffed nibble-for-nibble.
 *
 * Encodings:
 *   flag  — single nibble, an on/off marker. `on` gives the value the ROM
 *           writes when set, and the comparison is EXACT: a model that writes
 *           0x8 where the ROM writes 0xF diverges. That is deliberate — the
 *           goal is bit-exactness, so `on` is a claim about the ROM that the
 *           diff has to be able to falsify. Measure before you set it.
 *   nz    — single nibble deliberately compared only as nonzero-vs-zero,
 *           because the ROM stores something in the low bits that we do not
 *           model. Lossy on purpose; every use needs a comment saying what was
 *           measured and why the raw value cannot be compared.
 *   hexN  — N nibbles, base-16, little-endian by default (low nibble at addr).
 *   bcdN  — N nibbles, base-10 (the P1 keeps age, weight and clock in decimal).
 *
 * The criterion for `flag` over `nz` is the two oracles, not taste: if TamaLIB
 * and MAME produce the same raw nibble every minute, the exact value is a
 * property of the ROM and the model should be held to it. If they do not, it
 * is not a verification target no matter how the model encodes it.
 *
 * Nibble order is settled: little-endian. Decoding 0x20A-0x20C that way gives a
 * clean line and big-endian gives noise. Kept as a knob because a wrong order
 * is still the most legible explanation for a false diff on multi-nibble
 * fields — if every one of them diverges at minute 0 while every single-nibble
 * field agrees, flip DEFAULT_ORDER and rerun before hunting for a logic bug.
 */

export const DEFAULT_ORDER = "le"; // "le" = low nibble at base addr, "be" = high

export const FIELDS = [
  // addr    name                  width enc     notes
  // 0x040/0x041 are quarter-heart units, 0..0xF — not the 0..4 heart count the
  // LCD draws. Feeding is `add mx,0x4` clamped to 0xF (label_331, 0xCE5) and
  // decay is `add mx,0xC` clamped to 0 (label_376/378, 0xF99/0xFAE), so a full
  // meter is 15 and the ROM's power-on 1 is a quarter of a heart. The model
  // stores the raw unit and exposes hungerHearts/happyHearts for display. #2
  { addr: 0x040, name: "hunger",             w: 1, enc: "hex" },
  { addr: 0x041, name: "happy",              w: 1, enc: "hex" },
  { addr: 0x042, name: "careMistakes",       w: 1, enc: "hex" },
  { addr: 0x043, name: "discipline",         w: 1, enc: "hex" },
  { addr: 0x046, name: "weight",             w: 2, enc: "bcd" },
  // 0x048 is NOT a boolean sick flag — bit 3 is the flag, and the low 3 bits
  // are a medicine-shot counter with a residue that outlives the cure. Onset
  // writes 0xF; on freerun-baby (never cured) that reads 0 -> 15 at minute
  // 55 and 15 -> 0 at minute 408 when the pet dies, which is why the old
  // `flag, on: 0xf` encoding held up there (#5) — but tended-longlife under
  // the phase-2 macros cures at minute 56 and leaves a residue of 0x7, not
  // 0x0 or 0xF, so `flag` diverges the moment any scenario cures a pet.
  // Compared as the raw nibble instead, exactly like sicknessCount. #32
  { addr: 0x048, name: "sickByte",           w: 1, enc: "hex" },
  { addr: 0x049, name: "sicknessCount",      w: 1, enc: "hex" },
  // 0x04A is not a flag: asleep it holds 8-15, changing minute to minute, and
  // awake it is 0. Bit 3 is what tracks sleep — of 1568 nonzero samples across
  // six oracle traces every one has bit 3 set and not one lands in 1-7 — and
  // the low 3 bits are the sleep sprite's frame counter, which the model does
  // not have (measured since: the sprite advances every 406 ms with the lights
  // on and every 504 ms with them off, #60). It is `nz` rather than `flag` by
  // the criterion above: over lights-care-mistake's 769-minute night TamaLIB
  // and MAME disagree on the raw nibble 669 minutes out of 769, and agree on
  // nonzero-vs-zero 1201 out of 1201. Still OUT of DEFAULT_IGNORE — the
  // decoded value is worth comparing. #6
  //
  // `nz` is the reason the sprite's own carry can cost a divergent minute: the
  // ROM advances the frame counter by adding 1 to the WHOLE nibble and putting
  // bit 3 back one instruction later, so a sample landing in between reads 0
  // and `nz` calls that awake. That is corrected where it happens — in
  // tamalib_trace.c's dump_minute, which restores the bit and logs a `gap`
  // record — rather than here, because a comparator rule that ignored a lone
  // zero would also ignore a real one. #60
  { addr: 0x04a, name: "asleep",             w: 1, enc: "nz",   on: 0x8 },
  { addr: 0x04b, name: "lightsOn",           w: 1, enc: "flag", on: 0xf },
  { addr: 0x04d, name: "poopCount",          w: 1, enc: "hex" },
  // Measured: the ROM writes 0xF, at minute 14785 of tended-longlife under
  // the phase-2 macros — the first time 0x04E has been seen set. The old
  // on: 0x1 was a guess (#35). The model sets it from mainLoopPass()'s
  // label_372 arm, and only for a chart-0xF adult — a chart-6 Maskutchi
  // evolves into Bill instead of parking here (#21).
  // Named for what the asm says it means — "this adult outlived its evolution
  // timer", read only by the death sequence to pick a screen variant. The
  // community RAM notes (tama_notes.txt) call 0x04E the egg flag; the P1 has
  // no egg-laying (#22, #48).
  { addr: 0x04e, name: "adultTimerExpiredFlag", w: 1, enc: "flag", on: 0xf },
  { addr: 0x04f, name: "adultCareMistakes",  w: 1, enc: "hex" },
  { addr: 0x050, name: "growthChart",        w: 1, enc: "hex" },
  { addr: 0x051, name: "disciplineMistakes", w: 1, enc: "hex" },
  { addr: 0x054, name: "age",                w: 2, enc: "bcd" },
  { addr: 0x05a, name: "rng",                w: 1, enc: "hex",  volatile: true },
  { addr: 0x05d, name: "character",          w: 1, enc: "hex" },
  { addr: 0x07c, name: "eggTimer",           w: 1, enc: "hex" },
  { addr: 0x200, name: "hungerTimer",        w: 2, enc: "hex" },
  { addr: 0x202, name: "happyTimer",         w: 2, enc: "hex" },
  { addr: 0x204, name: "lightsTimer",        w: 2, enc: "hex" },
  { addr: 0x206, name: "poopTimer",          w: 2, enc: "hex" },
  // 0x208 is not a flag — the ROM writes all 16 values to it and the cores
  // agree on every one over freerun-baby. What it counts is now known: the
  // heart pass arms it (0xD as a Babytchi, 1 otherwise), the clock interrupt
  // advances it once a minute while nonzero and saturates at 0xF, and the main
  // loop books a care mistake the minute it reads 0xF. So it compares as a
  // plain nibble. #27, #3
  { addr: 0x208, name: "calling",            w: 1, enc: "hex" },
  // 0x209 is a counter, not a flag, and it is now measured: tended-week arms
  // it at 1 (minute 192, the first Marutchi scold request), the interrupt
  // advances it once a minute through the same label_328 0x208 goes through,
  // and label_382 books a discipline mistake into 0x051 and zeroes it at 0xF.
  // So it compares as a plain nibble, exactly like 0x208. #29
  { addr: 0x209, name: "scoldTimer",         w: 1, enc: "hex" },
  { addr: 0x20a, name: "neglectTimer",       w: 3, enc: "hex" },
  { addr: 0x20d, name: "sicknessTimer",      w: 3, enc: "hex" },
  { addr: 0x210, name: "evolutionTimer",     w: 3, enc: "hex" },
  { addr: 0x213, name: "disciplineCountdown",w: 1, enc: "hex" },
  // The Babytchi's private sleep clock, the mechanism behind the nap at
  // minutes 45-49 that used to be visible only as 0x04A going nonzero. 0x215
  // counts the nap down while asleep and 0x216/7 counts the waking period down
  // while awake; label_232 writes 5 and 0x28 at power-on and nothing ever
  // reloads them. Both are dead nibbles for every other character. #8
  { addr: 0x215, name: "babyNapTimer",       w: 1, enc: "hex" },
  { addr: 0x216, name: "babyAwakeTimer",     w: 2, enc: "hex" },
  // -------------------------------------------------------------------------
  // The per-character stat block, 0x230-0x249 — RAM, not a constant table.
  //
  // label_347 (0xDD2) loads it from the ROM table at 0x1564-0x15E5: twelve
  // `lbpx mx,<byte>` writing 0x230-0x247 LOW NIBBLE FIRST, then a `retd` whose
  // low nibble lands at 0x248 and whose high nibble lands at 0x249. So every
  // pair below is exactly one ROM byte, and the pairs that carry two fields
  // (0x23A/B, 0x242/3, 0x244/5, 0x246/7, 0x248/9) are split here the way the
  // ROM reads them, not the way it writes them. #37 read all ten blocks out of
  // the ROM; #54 put them in this table, which is what makes CHARACTERS
  // live-verified against the ROM's own copy on every scenario instead of only
  // indirectly through behaviour. Costs 26 nibbles a record.
  //
  // Everything here is the ROM's own encoding: hours and rates and timers are
  // plain hex spread little-endian (hour 23 is 0x17, rate 81 is 0x51), and the
  // two weight bounds are BCD exactly like 0x046/7, which is the bound they are
  // compared against by label_214. A character with no wake/sleep clock (the
  // Babytchi) carries 0xFF in both hour bytes and 0xF at 0x243 for "no
  // discipline countdown" — sentinels the ROM stores, not the model's nulls.
  { addr: 0x230, name: "statWakeHour",       w: 2, enc: "hex" },
  { addr: 0x232, name: "statSleepHour",      w: 2, enc: "hex" },
  // 0x234/5 and 0x236/7 are the LIVE rates: label_363 (0xF3D) decays them in
  // place on every wake once the pet is a final-form adult whose evolution
  // timer has run out, so these two are the only entries here that move within
  // a life. tended-longlife and oldie-strat are where that shows.
  { addr: 0x234, name: "statHungryRate",     w: 2, enc: "hex" },
  { addr: 0x236, name: "statHappyRate",      w: 2, enc: "hex" },
  { addr: 0x238, name: "statSicknessTime",   w: 3, enc: "hex" },
  { addr: 0x23b, name: "statMedicineDose",   w: 1, enc: "hex" },
  { addr: 0x23c, name: "statMinWeight",      w: 2, enc: "bcd" },
  { addr: 0x23e, name: "statMaxWeight",      w: 2, enc: "bcd" },
  { addr: 0x240, name: "statEvolutionTime",  w: 3, enc: "hex" },
  { addr: 0x243, name: "statDisciplineReload", w: 1, enc: "hex" },
  { addr: 0x244, name: "statInitialDiscipline", w: 1, enc: "hex" },
  { addr: 0x245, name: "statGameWinByte",    w: 1, enc: "hex" },
  { addr: 0x246, name: "statGameDelayWin",   w: 1, enc: "hex" },
  { addr: 0x247, name: "statGameDelayLose",  w: 1, enc: "hex" },
  // 0x248 is the bite count as the ROM stores it — 0 = 4 bites, 1 = 2 bites —
  // not the 4/2 the model's CHARACTERS table carries for display. 0x249 is the
  // high nibble of that same `retd` byte and reads 0 in all ten blocks, so it
  // is compared as the constant zero the ROM writes rather than left out.
  { addr: 0x248, name: "statBitesByte",      w: 1, enc: "hex" },
  { addr: 0x249, name: "statRetdHigh",       w: 1, enc: "hex" },
];

/**
 * Fields excluded from a normal diff.
 *
 * `rng` (0x05A) is a free-running counter driven by the programmable timer
 * interrupt, not by the one-minute clock. It advances ~2194.29 times a minute
 * (256 Hz prescaler / reload 7, measured on both cores — #15), so a
 * minute-quantised model cannot track it and comparing it produces noise on
 * every single row. Do not try to fit a rate to it: `analyze-rng` in
 * compare.mjs can only report the residue mod 16, and the adapters' opt-in
 * fast probes (TRACE_FAST_OUT) are what measure the real thing.
 */
export const DEFAULT_IGNORE = new Set(["rng"]);

/** Which RAM addresses the oracle needs to dump. */
export function addressesToDump() {
  const out = [];
  for (const f of FIELDS) for (let i = 0; i < f.w; i++) out.push(f.addr + i);
  return out.sort((a, b) => a - b);
}

/** Decoded model value -> { addr: nibble, ... } */
export function encodeField(f, value, order = DEFAULT_ORDER) {
  const out = {};
  if (f.enc === "flag" || f.enc === "nz") {
    out[f.addr] = value ? f.on : 0x0;
    return out;
  }
  const base = f.enc === "bcd" ? 10 : 16;
  let v = Math.max(0, Math.trunc(value ?? 0));
  const digits = [];
  for (let i = 0; i < f.w; i++) {
    digits.push(v % base);
    v = Math.floor(v / base);
  }
  // digits[0] is least significant
  const seq = order === "le" ? digits : digits.slice().reverse();
  seq.forEach((d, i) => { out[f.addr + i] = d; });
  return out;
}

/** { addr: nibble, ... } -> decoded value */
export function decodeField(f, ram, order = DEFAULT_ORDER) {
  // A flag compares as the raw nibble, so a wrong `on` shows up as a diff
  // rather than being silently swallowed by a truthiness test. `nz` is the
  // opt-in escape hatch for nibbles whose exact value we cannot predict.
  if (f.enc === "flag") return ram[f.addr] ?? 0;
  if (f.enc === "nz") return (ram[f.addr] ?? 0) ? 1 : 0;
  const base = f.enc === "bcd" ? 10 : 16;
  const nibbles = [];
  for (let i = 0; i < f.w; i++) nibbles.push(ram[f.addr + i] ?? 0);
  const seq = order === "le" ? nibbles : nibbles.slice().reverse();
  let v = 0;
  for (let i = seq.length - 1; i >= 0; i--) v = v * base + seq[i];
  return v;
}

/** Model dumpRam() (decoded, keyed by base addr) -> flat nibble map. */
export function encodeAll(dump, order = DEFAULT_ORDER) {
  const ram = {};
  for (const f of FIELDS) Object.assign(ram, encodeField(f, dump[f.addr], order));
  return ram;
}

export const fieldAt = (addr) =>
  FIELDS.find((f) => addr >= f.addr && addr < f.addr + f.w);
