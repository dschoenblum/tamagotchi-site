/**
 * tama-p1-model.js
 * A behavioral reimplementation of the Tamagotchi P1 (Bandai, 1996).
 *
 * GOAL: bit-exact agreement with the real ROM on all observable state,
 * verified by differential testing against TamaLIB. This is NOT an emulator —
 * it's a reimplementation of the game logic, so it can be modified afterward.
 *
 * CONFIDENCE TAGS on every rule and constant:
 *   [ROM]        Read directly out of the ROM by ROM datamining. Trust it.
 *   [DERIVED]    Computed from [ROM] data by a rule that reproduces every
 *                published value exactly. High confidence, still worth a diff.
 *   [INFERRED]   My reconstruction of a mechanism from observed behavior.
 *                Plausible, unproven. PRIME SUSPECTS when a diff fails.
 *   [UNKNOWN]    Placeholder. Not documented anywhere I could find.
 *                Must be resolved from the disassembly or by experiment.
 *
 * PRIMARY SOURCES
 *   RAM map, evolution vectors, per-character stat tables:
 *     https://rhubarbtart.neocities.org/p1hackinglog
 *     https://rhubarbtart.neocities.org/file/tama_notes.txt
 *     https://rhubarbtart.neocities.org/file/stats.txt
 *   Round-trippable full disassembly (the actual ground truth):
 *     https://github.com/agg23/tamagotchi-disassembled  -> tama.asm
 *   Reference emulator for differential testing:
 *     https://github.com/jcrona/tamalib
 *
 * TIME BASE
 *   1 tick = 1 minute of emulated time. Every documented counter in the P1 is
 *   driven off the 1-minute clock interrupt, so this is the natural quantum.
 *   Sub-minute behavior (animations, the guessing game, feeding frames) is
 *   modeled as instantaneous side effects of discrete actions.
 *
 * State fields are named after the RAM addresses they mirror, so a dump from
 * this model can be diffed nibble-for-nibble against a TamaLIB RAM dump.
 * See dumpRam() at the bottom.
 */

// ---------------------------------------------------------------------------
// Character indices (RAM 0x05D)                                        [ROM]
// ---------------------------------------------------------------------------

export const CHAR = {
  BABYTCHI: 0x1,
  MARUTCHI: 0x2,
  TAMATCHI: 0x3,
  KUCHITAMATCHI: 0x4,
  MAMETCHI: 0x5,
  GINJIROTCHI: 0x6,
  MASKUTCHI: 0x7,
  KUCHIPATCHI: 0x8,
  NYOROTCHI: 0x9,
  TARAKOTCHI: 0xa,
  BILL: 0xb,
};

export const STAGE = {
  EGG: "egg",
  BABY: "baby",
  CHILD: "child",
  TEEN: "teen",
  ADULT: "adult",
  DEAD: "dead",
};

// ---------------------------------------------------------------------------
// Per-character stat vector — mirrors RAM 0x230..0x249                 [ROM]
//
// This whole block is loaded from a jump table in ROM when a character is
// initialized, and every value below has now been read back out of that ROM
// rather than transcribed from the published dataminer's dump (#37).
//
// Where it lives. label_347 (0xDD2), the character loader, builds the block
// pointer as 0x1500 + 0x58 + character id, so 0x1558-0x1563 is a 12-entry
// dispatch of `jp label_397..label_406`, one per 0x05D of 0..11. Entries 0
// and 1 both point at label_397 (Babytchi) and entry 11 (Bill) points at
// label_401, Mametchi's block. Each block is twelve `lbpx mx,<byte>` writing
// 0x230-0x247 LOW NIBBLE FIRST, then a `retd <byte>` whose low nibble is
// 0x248; multi-nibble fields are little-endian nibbles as everywhere else.
// The ten blocks span 0x1564-0x15E5:
//
//   Babytchi      label_397 0x1564      Ginjirotchi   label_402 0x15A5
//   Marutchi      label_398 0x1571      Maskutchi     label_403 0x15B2
//   Tamatchi      label_399 0x157E      Kuchipatchi   label_404 0x15BF
//   Kuchitamatchi label_400 0x158B      Nyorotchi     label_405 0x15CC
//   Mametchi      label_401 0x1598      Tarakotchi    label_406 0x15D9
//                                       (Bill re-uses label_401)
//
// Every field below that lives in 0x230-0x248 is therefore [ROM]: decoded
// from those words and checked value-by-value against this table, all ten
// blocks, no disagreements. Since #54 that check is not a one-off: this table
// is the SOURCE loadStatBlock() copies into the model's own 0x230-0x249, the
// harness compares those 26 nibbles every minute of every scenario, and a
// value below that disagreed with the ROM's block would name itself in the
// diff the minute its character appears. Three things here are NOT in the blocks and keep
// their own sourcing — `name`/`stage`, which are ours; `shots`, the published
// count, which follows from the dose arithmetic below; and
// `initialDisciplineType1`, which is label_349's (0xDFC) literal 8 written
// over 0x043 when the new chart is 2 or 4, not a stat-block field at all.
//
// `shots` is the published "number of medicine presses to cure" value. It
// is not what the ROM actually stores at 0x23B — that address is a per-shot
// DOSE, added into 0x048 mod 16 starting from the 0xF onset value, and the
// number of presses to cure falls out of the arithmetic (medicine(), #32).
// `medicineDoseByte` is the dose. Solving x_k = (0xF + k*dose) mod 16 for the
// first k with x_k < 8, over every dose 1..15, gives a clean table:
//
//   dose 0x1-0x8  -> cures in 1 shot   (8 doses map to shots=1)
//   dose 0x9-0xC  -> cures in 2 shots  (4 doses map to shots=2)
//   dose 0xD      -> cures in 3 shots  (unique)
//   dose 0xE      -> cures in 4 shots  (unique)
//   dose 0xF      -> cures in 8 shots  (unique)
//
// Babytchi's 0xC was the one measured value: tended-longlife falls sick at
// minute 55 (0x048 = 0xF) and, after two medicine presses in minute 56, reads
// 0x7 — 0xF -> 0xB -> 0x7. Every other dose was an [INFERRED] reuse of 0xC or
// 0x8 within the right shots equivalence class, because only the shot COUNT
// was published. #37 read all ten out of the ROM and every guess was right:
// the ROM only ever uses three dose bytes — 0x8 for the shots=1 characters,
// 0xC for the shots=2 ones and 0xD for Nyorotchi — which is exactly the
// "reuse one dose per shot count" the model had assumed. Each line below
// cites the word holding its 0x23A/B pair. A consequence worth writing down:
// the residue left in 0x048 after a cure is 0x7 for every 2- and 3-shot
// character and 0x0 for every 1-shot one, on every character, so #32's
// warning about a non-Babytchi cure diverging is moot in practice.
// ---------------------------------------------------------------------------

const C = (o) => Object.freeze(o);

export const CHARACTERS = Object.freeze({
  [CHAR.BABYTCHI]: C({
    name: "Babytchi",
    stage: STAGE.BABY,
    wakeHour: null,          // 0x230/1 = 0xFF: baby ignores the clock  [ROM]
    sleepHour: null,         // 0x232/3 = 0xFF                          [ROM]
    hungryRate: 3,           // 0x234/5, minutes per hungry heart       [ROM]
    happyRate: 4,            // 0x236/7                                 [ROM]
    timeToSickness: 45,      // 0x238-A, minutes                        [ROM]
    shots: 2,                // 0x23B, published shot count             [ROM]
    medicineDoseByte: 0xc,   // 0x23B @0x1569 = 0xC0; tl 55/56 agrees   [ROM]
    minWeight: 5,            // 0x23C/D                                 [ROM]
    maxWeight: 5,            // 0x23E/F                                 [ROM]
    timeToEvolution: 60,     // 0x240-2, minutes                        [ROM]
    disciplineCountdown: null, // 0x243                                 [ROM]
    initialDiscipline: 0,    // 0x244, in 0x043's sixteenths (0..0xF)   [ROM]
    gameWinByte: 0x8,        // 0x245                                   [ROM]
    gameDelayWin: 1,         // 0x246                                   [ROM]
    gameDelayLose: 1,        // 0x247                                   [ROM]
    bites: 4,                // 0x248 (0 = 4 bites, 1 = 2 bites)        [ROM]
  }),
  [CHAR.MARUTCHI]: C({
    name: "Marutchi", stage: STAGE.CHILD,
    wakeHour: 9, sleepHour: 20,
    hungryRate: 50, happyRate: 60,
    timeToSickness: 990, shots: 2, medicineDoseByte: 0xc,   // 0x1576 = 0xC3 [ROM]
    minWeight: 10, maxWeight: 99,
    timeToEvolution: 1380,
    disciplineCountdown: 6, initialDiscipline: 0,
    gameWinByte: 0x8, gameDelayWin: 1, gameDelayLose: 1, bites: 4,
  }),
  [CHAR.TAMATCHI]: C({
    name: "Tamatchi", stage: STAGE.TEEN,
    wakeHour: 9, sleepHour: 21,
    hungryRate: 75, happyRate: 85,
    timeToSickness: 1656, shots: 2, medicineDoseByte: 0xc,  // 0x1583 = 0xC6 [ROM]
    minWeight: 20, maxWeight: 99,
    timeToEvolution: 2220,
    disciplineCountdown: 6,
    // Type 1 starts at 50% discipline, type 2 at 0%. Selected by the
    // growth-chart variable at 0x050. The 8 is label_349's own literal, and
    // it is measured: tended-week's Tamatchi loads 0x043 = 8 at minute
    // 3011. That is what pins 0x043 to sixteenths rather than quarters.
    //                                                                  [ROM]
    initialDiscipline: 0, initialDisciplineType1: 8,
    gameWinByte: 0x8, gameDelayWin: 1, gameDelayLose: 1, bites: 2,
  }),
  [CHAR.KUCHITAMATCHI]: C({
    name: "Kuchitamatchi", stage: STAGE.TEEN,
    wakeHour: 9, sleepHour: 21,
    hungryRate: 75, happyRate: 85,
    timeToSickness: 660, shots: 2, medicineDoseByte: 0xc,   // 0x1590 = 0xC2 [ROM]
    minWeight: 20, maxWeight: 99,
    timeToEvolution: 1380,
    disciplineCountdown: 6,
    initialDiscipline: 0, initialDisciplineType1: 8,
    gameWinByte: 0x8, gameDelayWin: 1, gameDelayLose: 1, bites: 4,
  }),
  [CHAR.MAMETCHI]: C({
    name: "Mametchi", stage: STAGE.ADULT,
    wakeHour: 9, sleepHour: 22,
    hungryRate: 81, happyRate: 91,
    timeToSickness: 3900, shots: 1, medicineDoseByte: 0x8,  // 0x159D = 0x8F [ROM]
    minWeight: 30, maxWeight: 99,
    timeToEvolution: 4095,
    // 0xF measured: tended-week's Mametchi loads 0x043 = 0xF at minute 7391,
    // which is the published "100%" in the units 0x043 actually uses. Every
    // other character's 0x244 was the same conversion applied to a published
    // percentage, and [INFERRED] on that basis, until #37 read the blocks:
    // 0x244 is the low nibble of each block's eleventh word — 0x15A2 = 0x8F
    // here — and all ten matched what this table already carried.       [ROM]
    disciplineCountdown: null, initialDiscipline: 0xf,
    gameWinByte: 0x8, gameDelayWin: 1, gameDelayLose: 1, bites: 2,
  }),
  [CHAR.GINJIROTCHI]: C({
    name: "Ginjirotchi", stage: STAGE.ADULT,
    wakeHour: 9, sleepHour: 22,
    hungryRate: 81, happyRate: 91,
    timeToSickness: 2808, shots: 1, medicineDoseByte: 0x8,  // 0x15AA = 0x8A [ROM]
    minWeight: 30, maxWeight: 99,
    timeToEvolution: 3120,
    disciplineCountdown: 7, initialDiscipline: 8,
    gameWinByte: 0x8, gameDelayWin: 1, gameDelayLose: 1, bites: 2,
  }),
  [CHAR.MASKUTCHI]: C({
    // The one adult whose evolution timer means something: a type-2 Maskutchi
    // carries chart 6, not 0xF, so label_372 evolves it into Bill when this
    // timer runs out (#21, see evolve()). The whole 12-word block was read out
    // of the ROM to date it — label_403 at 0x15B2, the entry the 0x1558 table
    // selects for 0x05D = 7 — and every value below matches the published
    // datamining. 0x240/1 = 0x40 and 0x242/3 = 0x7B, so 0x240-2 is 0, 4, 0xB =
    // 0xB40 little-endian = 2880 minutes. That is 48 hours of AWAKE time —
    // sleep freezes the timer — and Maskutchi's night is 23:00-11:00, so
    // 2880 = 4 x 720 awake minutes lands Bill exactly 4 wall-clock days after
    // the Maskutchi appears. #21's "roughly 4 days" folklore was right about
    // the calendar and wrong about the constant, which is why looking for a
    // 5760 anywhere in the ROM would have failed.
    // 0x23A/B = 0x8A gives the dose byte in the same read (#37).         [ROM]
    name: "Maskutchi", stage: STAGE.ADULT,
    wakeHour: 11, sleepHour: 23,
    hungryRate: 55, happyRate: 65,
    timeToSickness: 2592, shots: 1, medicineDoseByte: 0x8,  // 0x15B7 = 0x8A [ROM]
    minWeight: 30, maxWeight: 99,
    timeToEvolution: 2880,   // 0x240-2 at 0x15BA/B, 48 h                [ROM]
    disciplineCountdown: 7, initialDiscipline: 0,
    gameWinByte: 0xb, gameDelayWin: 3, gameDelayLose: 2, bites: 2,
  }),
  [CHAR.KUCHIPATCHI]: C({
    name: "Kuchipatchi", stage: STAGE.ADULT,
    wakeHour: 9, sleepHour: 22,
    hungryRate: 60, happyRate: 70,
    timeToSickness: 1170, shots: 2, medicineDoseByte: 0xc,  // 0x15C4 = 0xC4 [ROM]
    minWeight: 20, maxWeight: 99,
    timeToEvolution: 1560,
    disciplineCountdown: null, initialDiscipline: 0xf,
    gameWinByte: 0x5, gameDelayWin: 3, gameDelayLose: 4, bites: 2,
  }),
  [CHAR.NYOROTCHI]: C({
    name: "Nyorotchi", stage: STAGE.ADULT,
    wakeHour: 9, sleepHour: 22,
    hungryRate: 60, happyRate: 70,
    // The one dose the table above could pin without the ROM — 0xD is the
    // only byte that cures in 3 shots — and the ROM agrees, so the
    // derivation still holds but is no longer what this rests on.
    timeToSickness: 360, shots: 3, medicineDoseByte: 0xd,   // 0x15D1 = 0xD1 [ROM]
    minWeight: 10, maxWeight: 99,
    timeToEvolution: 780,
    disciplineCountdown: 7, initialDiscipline: 8,
    gameWinByte: 0x8, gameDelayWin: 1, gameDelayLose: 1, bites: 4,
  }),
  [CHAR.TARAKOTCHI]: C({
    name: "Tarakotchi", stage: STAGE.ADULT,
    wakeHour: 10, sleepHour: 22,
    hungryRate: 45, happyRate: 50,
    timeToSickness: 660, shots: 2, medicineDoseByte: 0xc,   // 0x15DE = 0xC2 [ROM]
    minWeight: 20, maxWeight: 99,
    timeToEvolution: 1440,
    disciplineCountdown: 7, initialDiscipline: 0,
    gameWinByte: 0x8, gameDelayWin: 1, gameDelayLose: 1, bites: 2,
  }),
  [CHAR.BILL]: C({
    // Bill shares Mametchi's entire stat vector — literally, not by
    // coincidence: entry 11 of the 0x1558 dispatch is `jp label_401`, which
    // is Mametchi's own block at 0x1598. Read for #37.                 [ROM]
    name: "Bill", stage: STAGE.ADULT,
    wakeHour: 9, sleepHour: 22,
    hungryRate: 81, happyRate: 91,
    timeToSickness: 3900, shots: 1, medicineDoseByte: 0x8,  // 0x159D = 0x8F [ROM]
    minWeight: 30, maxWeight: 99,
    timeToEvolution: 4095,
    disciplineCountdown: null, initialDiscipline: 0xf,
    gameWinByte: 0x8, gameDelayWin: 1, gameDelayLose: 1, bites: 2,
  }),
});

// ---------------------------------------------------------------------------
// Aging: the hungry/happy rate decay                                    [ROM]
//
// The published hungry/happy "vectors" for every adult are exactly reproduced
// by: next = ceil(rate * 3/4), iterated 11 times from the base rate (12 entries
// total) — 88/88 published values, hungry and happy, for all four adults.
//
//   Mametchi hungry: 81 61 46 35 27 21 16 12 9 7 6 5
//   Tarakotchi happy: 50 38 29 22 17 13 10 8 6 5 4 3
//
// The generator is now read out of the ROM rather than fitted: label_363
// (0xF3D) is a two-nibble `value -= value >> 2`, which is exactly ceil(3v/4),
// and label_360 (0xF2A) calls it on 0x234/5 and 0x236/7. So this table is not a
// table at all — the ROM mutates the live rate in place, and rateCurve() below
// is kept only because the published vectors are stated as vectors and
// verifyRateCurve() checks the model's arithmetic against them.
//
// WHEN it steps was [INFERRED] and wrong. label_360 sits on the WAKE path,
// three instructions after the age increment, and its gate is
//
//     0x050 == 0xF  &&  0x210-2 == 0
//
// — the same "final-form adult whose evolution timer has run out" idiom
// label_388 uses to decide whether a care mistake also books into 0x04F (#28).
// There is no sickness term and no day counter: the model's old
// hasBeenSickAsAdult / RATE_STEP_PER_DAY pair is not in the ROM. One step per
// wake, which is not one per day for any pet whose nights get interrupted.
// See tickSleepTransition() and #19.
// ---------------------------------------------------------------------------

export const RATE_STAGES = 12;                                    // [DERIVED]

export function rateCurve(base, stages = RATE_STAGES) {
  const out = [base];
  for (let i = 1; i < stages; i++) out.push(Math.ceil((out[i - 1] * 3) / 4));
  return out;
}

// ---------------------------------------------------------------------------
// Evolution vectors (7 growth charts, selected by RAM 0x050)           [ROM]
//
// The ROM walks each vector front-to-back comparing care mistakes, then
// discipline mistakes, and takes the first entry that matches. Encoded here as
// ordered predicates — first match wins. Order is significant.
// ---------------------------------------------------------------------------

// NOTE: keys are namespaced strings, not bare integers — growth chart numbers
// 1..4 would otherwise collide with the character IDs 1..4 in CHAR.
// The evolution decision, transcribed from the ROM. label_346 (0xDC6)
// dispatches on the current chart at 0x050, and each branch (label_339-345,
// 0xD9C-0xDC5) stages a table of four-nibble rows [care mistakes >=,
// discipline mistakes >=, new chart, new character] at 0x090. label_113
// (0x35D) scans it against 0x042 and 0x051, first match wins, and label_115
// writes the winning row straight into 0x050 and 0x05D. So the chart ids
// below ARE the 0x050 values: 0 = Babytchi, 1 = Marutchi, 2/3 = Tamatchi
// type 1/2, 4/5 = Kuchitamatchi type 1/2, 6 = the type-2 Maskutchi, and
// every other adult is written chart 0xF — which is the value label_388's
// 0x050 == 0xF test (#28) is detecting, and label_372's too. Chart 6's one
// row is Bill, and it IS reached: label_372 sends any chart other than 0xF to
// the evolution animation whatever the pet's stage, so the type-2 Maskutchi
// evolves on its own 2880-minute timer like a child would (#21).       [ROM]
const GROWTH_CHARTS = Object.freeze({
  0: [ // Babytchi (label_339)
    { care: 0, disc: 0, chart: 1, to: CHAR.MARUTCHI },
  ],
  1: [ // Marutchi (label_340)
    { care: 3, disc: 3, chart: 5, to: CHAR.KUCHITAMATCHI },
    { care: 3, disc: 0, chart: 4, to: CHAR.KUCHITAMATCHI },
    { care: 0, disc: 3, chart: 3, to: CHAR.TAMATCHI },
    { care: 0, disc: 0, chart: 2, to: CHAR.TAMATCHI },
  ],
  2: [ // Tamatchi type 1 (label_341)
    { care: 3, disc: 4, chart: 0xf, to: CHAR.TARAKOTCHI },
    { care: 3, disc: 2, chart: 0xf, to: CHAR.NYOROTCHI },
    { care: 3, disc: 0, chart: 0xf, to: CHAR.KUCHIPATCHI },
    { care: 0, disc: 2, chart: 0xf, to: CHAR.MASKUTCHI },
    { care: 0, disc: 1, chart: 0xf, to: CHAR.GINJIROTCHI },
    { care: 0, disc: 0, chart: 0xf, to: CHAR.MAMETCHI },
  ],
  3: [ // Tamatchi type 2 (label_342) — the only path to chart 6
    { care: 4, disc: 8, chart: 0xf, to: CHAR.TARAKOTCHI },
    { care: 4, disc: 0, chart: 0xf, to: CHAR.NYOROTCHI },
    { care: 0, disc: 2, chart: 6,   to: CHAR.MASKUTCHI },
    { care: 0, disc: 0, chart: 0xf, to: CHAR.GINJIROTCHI },
  ],
  4: [ // Kuchitamatchi type 1 (label_343) — care mistakes stop mattering here
    { care: 0, disc: 3, chart: 0xf, to: CHAR.TARAKOTCHI },
    { care: 0, disc: 2, chart: 0xf, to: CHAR.NYOROTCHI },
    { care: 0, disc: 0, chart: 0xf, to: CHAR.KUCHIPATCHI },
  ],
  5: [ // Kuchitamatchi type 2 (label_344)
    { care: 0, disc: 6, chart: 0xf, to: CHAR.TARAKOTCHI },
    { care: 0, disc: 0, chart: 0xf, to: CHAR.NYOROTCHI },
  ],
  6: [ // Maskutchi via the type-2 chart (label_345, 0xDC4) — the secret path.
       // One unconditional row: 48 hours after the type-2 Tamatchi becomes a
       // Maskutchi, whatever its care and discipline, it becomes Bill (#21).
    { care: 0, disc: 0, chart: 0xf, to: CHAR.BILL },
  ],
});

// ---------------------------------------------------------------------------
// Tunable constants
// ---------------------------------------------------------------------------

export const RULES = {
  // --- power-on state ------------------------------------------------------
  // Written by label_232 (tama.asm 0x761-0x791), the "new game" init the ROM
  // runs on its way into the boot / clock-set screen. Anything not listed here
  // is left at the reset value of 0: set_init_mem_and_int_cont_mem_clear
  // (0x244) zeroes 0x000-0x06F and 0x200-0x237 and nothing else touches them.
  //
  // These were previously labelled HATCH_* and applied at hatch time. They are
  // power-on values, not hatch values — label_347, the routine that loads a
  // character, does not touch 0x200/0x202/0x206 at all.
  //
  // There is no uniform "inactive" sentinel, which is what the shape of the
  // measured data first suggested. label_232 writes 0xFF to 0x204/5, 0x0F to
  // 0x206/7, and 0xF to the TOP nibble only of the two three-nibble timers
  // (0x20F and 0x212, leaving the low two at 0); 0x200/1, 0x20A-C and 0x213 it
  // does not write at all. 0x206/7's 0x0F is not a marker either — it is a live
  // 15-minute countdown, and the first poop lands 15 minutes after the hatch.
  //
  // All of it confirmed by measurement: minute 0 is nibble-identical across
  // freerun-baby, freerun-week, oldie-strat and lights-care-mistake, at start
  // hours 9 and 19, under both TamaLIB and MAME.                        [ROM]
  POWER_ON_HUNGER: 0x1,          // 0x040                              [ROM]
  POWER_ON_HAPPY: 0x1,           // 0x041                              [ROM]
  POWER_ON_WEIGHT: 5,            // 0x046/7                            [ROM]
  POWER_ON_HUNGER_TIMER: 0,      // 0x200/1                            [ROM]
  POWER_ON_HAPPY_TIMER: 2,       // 0x202/3                            [ROM]
  POWER_ON_LIGHTS_TIMER: 0xff,   // 0x204/5, which is also LIGHTS_CLAMP [ROM]
  POWER_ON_POOP_TIMER: 0x0f,     // 0x206/7                            [ROM]
  POWER_ON_SICKNESS_TIMER: 0xf00,  // 0x20D-F, only 0x20F is written    [ROM]
  POWER_ON_EVOLUTION_TIMER: 0xf00, // 0x210-2, only 0x212 is written    [ROM]

  // --- hearts --------------------------------------------------------------
  // 0x040 and 0x041 are NOT heart counts. They are quarter-heart units in a
  // single nibble: label_331 (0xCE5) feeds with `add mx,0x4` clamped to 0xF,
  // and label_376/378 (0xF99/0xFAE) decay with `add mx,0xC` — a subtract of 4 —
  // clamped to 0. So a full meter is 0xF rather than 16, four meals fill it
  // from empty, and the display is ceil(units / 4). This is what the ROM's
  // power-on 1 means: a quarter of a heart, which shows as one heart and is
  // gone on the newborn's first decay.                                  [ROM]
  HEART_STEP: 4,                // one heart, in 0x040/0x041 units      [ROM]
  HEART_FULL: 0xf,              // feeding clamps here, so 4 hearts = 15 [ROM]

  EGG_MINUTES: 5,               // 0x07C initialized to 5              [ROM]
  EGG_HATCHED: 0xf,             // 0x07C parks at 0xF once hatched     [ROM]
  // 0x243 for a character with no discipline countdown. Babytchi's is 0xF and
  // label_348 (0xDF0) copies it straight into 0x213, so the "off" state is
  // all-ones rather than 0.                                            [ROM]
  DISCIPLINE_COUNTDOWN_OFF: 0xf,
  // 0x230/1 and 0x232/3 for a character with no wall-clock bedtime. Babytchi's
  // block writes the bytes 0xFF/0xFF there (its own two counters at 0x215-7 are
  // its bedtime instead), so "no clock" is all-ones in RAM and not a null.
  // Measured: minute 6 of freerun-baby reads 0x230-0x233 = F F F F.     [ROM]
  SLEEP_CLOCK_OFF: 0xff,
  // The reload the poop animation writes into 0x206/7, and which of the two
  // values goes with which character. Both are read straight out of label_109,
  // the poop animation's RAM writes: 0x337 stores 0xB4 (180) into 0x206/7
  // unconditionally (`lbpx mx, 0xB4` with x = 0x206), then 0x339 tests
  // 0x05D == 1 and 0x33C overwrites it with 0x19 (25) when that holds. 0x05D
  // is the character index and 1 is Babytchi (CHAR.BABYTCHI), so the short
  // interval is the baby's and the long one is everybody else's — the
  // assignment is a ROM branch, not an inference from cadence.          [ROM]
  // Exercised on both sides too: freerun-baby drops on the 25-minute cadence
  // and mametchi-start (character poked, so the split is not inferred from
  // stage) drops at minute 16 and again at 196, both bit-exact (#68).
  POOP_INTERVAL_BABY: 25,       // 0x33C, taken when 0x05D == 1         [ROM]
  POOP_INTERVAL_OTHER: 180,     // 0x337, the unconditional store       [ROM]

  // --- the attention call, 0x208 -------------------------------------------
  // A heart-based care mistake is NOT booked off the neglect counter. 0x208 is
  // a one-nibble countdown-to-a-mistake that the heart pass arms whenever a
  // meter empties (label_376/378 set 0x05C = 2, and the animation dispatcher
  // runs label_106 at 0x31C). The clock interrupt then advances it once a
  // minute *only if it is nonzero* and saturates at 0xF (label_328, 0xCD9),
  // and the main loop books the mistake the minute it reads 0xF, zeroing it
  // (label_381 -> label_388, 0xFC6/0xFDF). Re-arming it before it saturates is
  // what makes a fast character look immune: a Babytchi's 3-minute hunger rate
  // keeps resetting the count to 0xD.                                    [ROM]
  //
  // The arm value depends on 0x05D, and so does whether the mistake is booked
  // at all: label_381 skips label_388 when 0x05D == 1, so a Babytchi's calls
  // saturate and are thrown away. That is measured too — 0x042 is 0 for the
  // whole Babytchi stage of freerun-baby and first moves at minute 86, 14
  // minutes after the first arm as a Marutchi.
  CALL_ARM_BABY: 0xd,           // 0x05D == 1: label_106 (0x322), with buzzer
  CALL_ARM: 0x1,                // otherwise: label_108 (0x327), silent
  CALL_FULL: 0xf,               // label_328 saturates, label_381 books here

  // --- lights, 0x204/0x205 -------------------------------------------------
  // Two nibbles, saturating — label_316 (0xC8E) increments and pins at 0xFF on
  // carry. Measured: 1097 of the 1201 minutes of lights-care-mistake read 255.
  // The verb matters, and it is "saturate": nothing here wraps.          [ROM]
  LIGHTS_CLAMP: 0xff,
  // Falling asleep reloads it (label_102, 0x30C). A Babytchi gets 0x3D, which
  // is inert because label_314 never reaches label_316 while 0x05D == 1 — the
  // baby branch decrements 0x215 instead. Measured at minute 45 of
  // lights-care-mistake: 0x204/5 goes 0xFF -> 0x3D and sits there.       [ROM]
  LIGHTS_SLEEP_RELOAD: 0x00,
  LIGHTS_SLEEP_RELOAD_BABY: 0x3d,
  // label_361 (0xF35) books the mistake off the HIGH NIBBLE alone: fire when
  // 0x205 is 4..0xE, i.e. the counter has reached 64, and disarm by writing
  // 0xF to 0x205 rather than by clearing the counter. Measured at minute 134
  // of lights-care-mistake: 63 -> 240 with 0x042 going 0 -> 1, then a climb to
  // 255 and no second mistake for the rest of the night.                 [ROM]
  LIGHTS_MISTAKE_HI: 0x4,       // 64 minutes, expressed the way the ROM tests it
  LIGHTS_DISARMED_HI: 0xf,
  // Turning the lights off writes the same 0xF to 0x205 (label_298, 0xAD6) —
  // it disarms the counter, it does not zero it. Turning them back on does not
  // re-arm; only falling asleep does.                                    [ROM]

  // --- the Babytchi nap, 0x215 and 0x216/0x217 -----------------------------
  // A baby ignores the wall clock (0x230/0x232 = 0xFF) and runs two counters
  // of its own instead. Both are written exactly once, by the power-on block
  // at label_232 (0x78D): 0x215 = 5, 0x216/7 = 0x28 = 40.
  //
  // While 0x05D == 1 the clock interrupt services exactly one of them, chosen
  // by the same 0x04A bit-3 test that gates everything else:
  //   awake  — label_318 (0xC9A) decrements the two-nibble 0x216/7, floor 0
  //   asleep — label_314 (0xC89) decrements the one-nibble 0x215, floor 0
  // and the main loop reads them back: label_364 (0xF4C) puts an awake baby to
  // sleep when 0x215 is nonzero AND 0x216/7 reads 0, label_357 (0xF13) wakes a
  // sleeping one when 0x215 reads 0.
  //
  // Nothing in the ROM ever reloads either counter — the only `ld x,0x15`/
  // `ld y,0x16` sites in page 2 are that init block and those three reads — so
  // the nap happens exactly once per life: 40 minutes awake, 5 asleep, and
  // then 0x215 sits at 0 and label_364's first test fails for good. That
  // settles the cadence-or-one-off question in #8 from the disassembly rather
  // than from a trace long enough to see a second nap.                   [ROM]
  //
  // The 40 counts from the hatch, not from power-on: check_0xX5D_is_1 is false
  // while 0x05D is 0, so the egg never decrements it. Measured on
  // freerun-baby and lights-care-mistake, which start at 09:00 and 19:00 and
  // nap over the identical minutes 45-49 (#8).
  BABY_AWAKE_MINUTES: 0x28,     // 0x216/7 at power-on                   [ROM]
  BABY_NAP_MINUTES: 0x5,        // 0x215 at power-on                     [ROM]

  // --- the neglect counter, 0x20A-0x20C ------------------------------------
  // Three nibbles, and it does NOT clamp: label_330 (0xCDF) is a bare
  // add-with-carry chain with no saturate, so it rolls over 0xFFF -> 0x000.
  // Reachable in practice — oldie-strat wraps at minutes 4106, 8202, 12298 and
  // 16394.                                                               [ROM]
  NEGLECT_WRAP: 0x1000,

  SICKNESS_DEATH_COUNT: 3,      // 0x049 >= 3 -> death (label_367)     [ROM]

  // Settled against the ROM (#11): the cure path (label_192, 0x606-0x61B)
  // reloads the sickness timer from 0x238-A and never touches 0x049, and the
  // oracle shows 0x049 stay at 1 across the minute-55/56 cure of
  // tended-longlife — then drop to 0 at the minute-71 evolution. So the RAM
  // map's literal reading holds: 0x049 counts sicknesses per life stage and
  // resets only on evolution, never on cure.                            [ROM]
  SICKNESS_COUNT_RESETS_ON_CURE: false,

  // --- sickness, 0x048 -------------------------------------------------------
  // 0x048 is not a boolean sick flag: bit 3 is the flag, and the low 3 bits
  // are a medicine-shot counter (label_191/192, 0x600-0x61B). Falling sick
  // writes 0xF outright. Each medicine press effectively does
  // `mx = ((mx & 7) | 8) + dose` where dose is the character's 0x23B; the low
  // nibble of the sum is stored back, and if it comes out < 8 the carry past
  // bit 3 is the cure. The residue in the low bits is never cleared by a cure
  // and survives evolutions — only death (checkDeath()'s dying transition,
  // which zeros the whole byte) and a fresh onset (which rewrites 0xF) touch
  // it again. Measured on tended-longlife under the phase-2 macros: minute 55
  // onset reads 0xF, minute 56 after two same-minute shots reads 0x7 (cured,
  // residue 7) and that 7 is still there after the minute-71 evolution. #32
  SICKNESS_ONSET_BYTE: 0xf,                                          // [ROM]

  ADULT_CARE_MISTAKE_DEATH: 5,  // 0x04F hits 5 -> death (label_370)   [ROM]

  // The other two conditions in the death gate (label_367-371, 0xF5B-0xF75;
  // see checkDeath()). Both are NIBBLE tests, not plain compares: death needs
  // the counter's high nibble >= HI *and* its middle nibble >= MID, so the
  // range is not contiguous — a neglect counter at 0x300-0x3CF passes the
  // test a 0x2D0 fails, which matters once the counter wraps.           [ROM]
  //
  // Untreated sickness: 0x20F >= 1 && 0x20E >= 6 — the sick count-up reaching
  // 0x160 = 352 minutes. Verified twice: freerun-baby falls sick at 55 and
  // dies at 407-409; lights-care-mistake falls sick at 55, freezes the
  // counter at 15 through the night, and dies at 1177-1179 — the same 352,
  // ten wall-clock hours apart (label_369, 0xF6B).
  SICK_DEATH_HI: 0x1,                                                // [ROM]
  SICK_DEATH_MID: 0x6,                                               // [ROM]
  // Neglect: 0x20C >= 2 && 0x20B >= 0xD — the neglect counter reaching
  // 0x2D0 = 720 minutes with both meters empty (label_368, 0xF63). Never yet
  // observed firing (the free-run pets die of sickness first); the values
  // are read straight from the compare immediates.
  NEGLECT_DEATH_HI: 0x2,                                             // [ROM]
  NEGLECT_DEATH_MID: 0xD,                                            // [ROM]

  // --- discipline, 0x043 and 0x051 -----------------------------------------
  // 0x043 is in the same sixteenths the hearts use, not in quarters: the scold
  // handler (label_301, 0xAE3) does `add mx,0x4` and clamps to 0xF on carry, so
  // a scold is a quarter of the meter and full is 0xF. Measured on tended-week:
  // the first scold at minute 193 takes 0x043 from 0 to 4, the second at 371 to
  // 8, and a Mametchi loads 0xF (100%) at minute 7391.                  [ROM]
  DISCIPLINE_STEP: 4,
  DISCIPLINE_FULL: 0xf,
  // label_389 (0xFE8) is the shared `add mx,0x1; clamp 0xF` both mistake
  // counters go through — 0x042, 0x04F and 0x051 all saturate rather than wrap.
  // Measured on tended-neglect, where the ROM's 0x042 sits at 0xF from minute
  // 634 to the end of the run and the model's used to roll to 0 (#36).  [ROM]
  MISTAKE_CLAMP: 0xf,
  // 0x209 is armed at 1 by label_107/108 (0x324), exactly like 0x208, and the
  // same label_328 advances both once a minute (label_319 calls it for 0x208
  // then 0x209). CALL_FULL is where label_382 books the discipline mistake. #29
  SCOLD_ARM: 0x1,                                                    // [ROM]
  // label_110 (0x33D): the tray saturates at 8, and the poop that reaches 8
  // zeroes the sickness timer outright when the pet is not already sick — so
  // an eighth poop is an immediate illness, not a slow one.            [ROM]
  POOP_MAX: 8,

  // --- the guessing game ---------------------------------------------------
  // Entry writes 0x082 = 5 and each round resolves its own rng carry test
  // (label_282 against the character's 0x245); wins accumulate in 0x083 and
  // 0x6AE tests `cp mx,0x3` before running the +4 routine on 0x041. So the
  // game is best-of-five, not a single test.                            [ROM]
  GAME_ROUNDS: 5,
  GAME_WINS_TO_HAPPY: 3,

  // --- how the model resolves the pass/interrupt race ----------------------
  // The main loop runs many passes a second and the clock interrupt can land
  // in the middle of one. A pass that straddles it reads some counters from
  // before the minute's decrements and some from after, and the ROM's answer
  // to "which event wins this minute" changes accordingly — with nothing in
  // RAM to predict it from. Measured, all four on TamaLIB:
  //
  //   poop queue vs heart pass   tended-week 20      heart pass starved
  //                              lights-left-on 3255 heart pass ran anyway
  //   bedtime    vs heart pass   lights-care-mistake 71  starved (#30)
  //                              tended-week 2100        ran anyway
  //   evolution  vs heart pass   freerun-baby 70     starved (#2)
  //                              poop-pileup 70      ran anyway
  //
  // — three pairs, six measurements, same ROM, same minute in the last pair.
  //
  // So without help the model has to pick one and be wrong on the other. All
  // three default to "the queued event wins", which is what every free-running
  // scenario shows and what the asm reads literally: `jp set_0x5C_to_a` returns
  // out of the pass.
  //
  // THESE ARE THE NO-REPLAY FALLBACK. With the oracle's race log replayed
  // (`raceHints`, run-model.mjs --races, #38) every collision is resolved from
  // what the ROM's program counter actually did in that minute and none of
  // these is consulted. Without it they are the model's only answer and still a
  // coin call — tended-week diverges for 780 minutes on the default and
  // poop-pileup for 2931. Do not promote them: what they encode is "which way
  // did this run's coin land", and that answer is per-minute, not per-ROM.
  //                                                                [INFERRED]
  POOP_QUEUE_STARVES_HEART_PASS: true,
  SLEEP_STARVES_HEART_PASS: true,
  EVOLUTION_QUEUE_STARVES_HEART_PASS: true,

  // Which food gets which operand is written out twice in label_223/224, in
  // the immediate loaded into A just before the `call label_230` that adds it
  // to the BCD weight at 0x046/7:
  //
  //   meal   0x735  ld a, 0x1   // then 0x736  call label_230
  //   snack  0x746  ld a, 0x2   // then 0x747  call label_230
  //
  // The published "incremented by 1 or 2 when feeding" was right about the
  // pair; this is which is which.                                        [ROM]
  MEAL_WEIGHT: 1,               // label_223 (0x735)                        [ROM]
  SNACK_WEIGHT: 2,              // label_224 -> label_225 (0x746)           [ROM]
  GAME_WEIGHT_LOSS: 1,          // label_206 (0x6B6), BCD -1 with the floor [ROM]

  // --- the weight clamp, label_214 (0x6E5) ---------------------------------
  // label_214 is the ROM's one and only weight clamp, and it is TWO-SIDED. It
  // reads:
  //
  //   0x6E5  calz zero_a_xp          // xp = 0, so X addresses 0x04x
  //   0x6E8  ld y, 0x3D              // Y = 0x23D, minWeight's HIGH nibble
  //   0x6E9  call label_218          // C set iff 0x046/7 < 0x23C/D
  //   0x6EA  jp c, label_215         // below min -> copy min in
  //   0x6EB  ld y, 0x3F              // Y = 0x23F, maxWeight's HIGH nibble
  //   0x6EC  call label_218          // C set iff 0x046/7 < 0x23E/F
  //   0x6ED  jp c, label_217         // inside the window -> ret, no write
  //   0x6EE  ld y, 0x3E              // else fall into label_216 with Y=0x23E
  //   0x6F1  ld x, 0x46              // label_216: 0x046/7 <- the two nibbles
  //   0x6F3  calz copy_2_mx_my_ret   //            at Y-1, Y (interrupts off)
  //
  // label_218 (0x6F6) is the two-nibble compare: high nibbles first at
  // 0x047 vs my, `jp c`/`jp nz` out on a decision, and on a tie `adc yl,0xF`
  // steps Y down a nibble (carry is clear there, so +0xF is -1) to compare the
  // low ones. So the whole routine is: weight = clamp(weight, 0x23C/D,
  // 0x23E/F), min tested first.
  //
  // Every weight change in the ROM returns through it — a feed (label_231,
  // 0x760 `jp label_214`), a game (label_206, 0x6BE `call label_214`) and,
  // which is what #53 is about, a CHARACTER CHANGE: label_350 (0xDFE-0xDFF)
  // is the tail of label_347, the stat-vector load, and it tail-jumps into
  // label_214 after 0x230-0x247 already hold the NEW character's block. So a
  // hatch or an evolution clamps the carried-over weight into the incoming
  // character's window in both directions.
  //
  // The model only ever clamped up there. Measured on hardware by #53's poked
  // scenario: 0x046 poked to 20, free-running, and at the minute-6 hatch the
  // ROM writes the Babytchi's 5 (0x23E/F = 0x05) while the model kept 20.
  // Every other compared field agreed for all 121 minutes.
  //
  // The knob is the half that was missing, so flipping it off reproduces the
  // bug exactly; the up-clamp beside it has no knob and does not need one.
  //                                                                       [ROM]
  CHARACTER_CHANGE_CLAMPS_WEIGHT_DOWN: true,

  // "Snacks make it sick" is a real ROM mechanism, and it lives in the four
  // instructions after label_224's meter add that #44 stopped short of
  // reading (0x73C-0x745):
  //
  //   calz bit_high_at_0x048   // sick?
  //   jp   nz, label_225       //   yes -> straight to the weight add
  //   ld   a, 0x2 / ld xp, a / ld x, 0xD      // -> 0x20D
  //   calz clear_0x07D / call label_324 / calz set_f_0x07D
  //
  // label_324 (0xCC8) is the same three-nibble `add mx,0xF` / `adc mx,0xF`
  // borrow chain the clock interrupt runs on 0x20D-F, with the same floor at
  // 0 on underflow, and the clear/set of 0x07D disables interrupts across it
  // so the snack's decrement cannot race the minute's. So every snack fed to
  // a HEALTHY pet brings its next illness one minute closer; a snack fed to a
  // sick one skips the whole block. The meal path has no equivalent.
  //
  // Measured: snack-attack's seven snacks each cost the oracle's 0x20D-F an
  // extra minute at 76-79 and 81-83, and the minute-56 snack — fed to a sick
  // Babytchi — costs nothing.                                            [ROM]
  SNACK_SICKNESS_STEP: 1,       // label_224 -> label_324 (0x743)           [ROM]
};

/**
 * The two landings a boolean knob can express, as raceLanding() fallbacks.
 * The oracle's report has a third (`reach: 1`, the pure straddle — the pass ran
 * but read the heart timers from before the interrupt), which is why the knobs
 * cannot replace the log. See raceLanding() and #38.
 */
const RACE_STOPPED = Object.freeze({ reach: 0, svc: 0 });
const RACE_RAN     = Object.freeze({ reach: 2, svc: 1 });

// ---------------------------------------------------------------------------
// The RAM map — one table, read forwards by dumpRam() and backwards by pokeRam()
// ---------------------------------------------------------------------------

/**
 * Address -> property, with the width of the field in nibbles and how those
 * nibbles are packed. dumpRam() projects through it and pokeRam() writes back
 * through it, so the mapping exists once rather than as two tables that drift
 * apart. index.html builds its RAM panel from the same list, which is why the
 * panel's labels are the model's property names.
 *
 * `w`/`kind` mirror `w`/`enc` in harness/fields.mjs, deliberately duplicated
 * rather than imported: the model must not depend on the harness, and the
 * browser must not have to fetch a third file to run. selftest.mjs cross-checks
 * the two tables so the duplicate cannot rot silently.
 *
 * `max` is what the field's nibbles can physically hold, and it is the only
 * validation a poke gets — 0xF for one hex nibble, 99 for the two BCD nibbles
 * of weight, 0xFFF for the three of the neglect counter. `bool` is the model's
 * own encoding for a nibble it keeps as a flag: dumpRam() emits 1/0 and a poke
 * takes 0 or 1, because true/false is all the property can hold. Which nibble
 * the ROM writes for a set flag (0xF for 0x04B, 8-15 for 0x04A) is fields.mjs's
 * business, not the model's — #5, #6.                                     #25
 */
const ramField = (addr, prop, w = 1, kind = "hex") => ({
  addr, prop, w, kind,
  max: kind === "bool" ? 1 : (kind === "bcd" ? 10 : 16) ** w - 1,
});

export const RAM_MAP = [
  ramField(0x040, "hunger"),
  ramField(0x041, "happy"),
  ramField(0x042, "careMistakes"),
  ramField(0x043, "discipline"),
  ramField(0x046, "weight", 2, "bcd"),
  // 0x048 is a shot counter, not a flag — see the `sick` getter. #32
  ramField(0x048, "sickByte"),
  ramField(0x049, "sicknessCount"),
  ramField(0x04a, "asleep", 1, "bool"),
  ramField(0x04b, "lightsOn", 1, "bool"),
  ramField(0x04d, "poopCount"),
  // 0x04E is "this adult outlived its evolution timer", NOT an egg flag: the
  // community RAM notes (tama_notes.txt) call it the egg flag, but the only
  // branch on it in the whole ROM is at 0x390 inside label_116, where nonzero
  // selects an extra death-animation sequence. The P1 has no egg-laying and no
  // next generation (#22, #48).                                          [ROM]
  ramField(0x04e, "adultTimerExpiredFlag", 1, "bool"),
  ramField(0x04f, "adultCareMistakes"),
  ramField(0x050, "growthChart"),
  ramField(0x051, "disciplineMistakes"),
  ramField(0x054, "age", 2, "bcd"),
  ramField(0x05a, "rng"),
  ramField(0x05d, "character"),
  ramField(0x07c, "eggTimer"),
  ramField(0x200, "hungerTimer", 2),
  ramField(0x202, "happyTimer", 2),
  ramField(0x204, "lightsTimer", 2),
  ramField(0x206, "poopTimer", 2),
  // 0x208/0x209 are countdowns-to-a-mistake, not booleans. #3, #29
  ramField(0x208, "callTimer"),
  ramField(0x209, "scoldTimer"),
  ramField(0x20a, "neglectTimer", 3),
  ramField(0x20d, "sicknessTimer", 3),
  ramField(0x210, "evolutionTimer", 3),
  ramField(0x213, "disciplineCountdown"),
  ramField(0x215, "babyNapTimer"),
  ramField(0x216, "babyAwakeTimer", 2),
  // The stat block, 0x230-0x249 — RAM the ROM loads from its own table at an
  // evolution (label_347) and reads back every minute, so it is dumped, diffed
  // and pokeable like everything else here. Splitting it field by field rather
  // than as one opaque run is what makes CHARACTERS live-verified against the
  // ROM: a wrong rate or dose in the model's table names itself in the diff.
  // See loadStatBlock(). #54, #37
  ramField(0x230, "statWakeHour", 2),
  ramField(0x232, "statSleepHour", 2),
  ramField(0x234, "statHungryRate", 2),
  ramField(0x236, "statHappyRate", 2),
  ramField(0x238, "statSicknessTime", 3),
  ramField(0x23b, "statMedicineDose"),
  ramField(0x23c, "statMinWeight", 2, "bcd"),
  ramField(0x23e, "statMaxWeight", 2, "bcd"),
  ramField(0x240, "statEvolutionTime", 3),
  ramField(0x243, "statDisciplineReload"),
  ramField(0x244, "statInitialDiscipline"),
  ramField(0x245, "statGameWinByte"),
  ramField(0x246, "statGameDelayWin"),
  ramField(0x247, "statGameDelayLose"),
  ramField(0x248, "statBitesByte"),
  ramField(0x249, "statRetdHigh"),
];

/**
 * MODEL INTEGRITY, NOT A ROM RULE — the two RAM_MAP fields that are indices
 * into a model table rather than counters, and the only values pokeRam()
 * refuses (#55). Both were pokeable into a state the model cannot execute,
 * from #25's RAM panel or #42's poke block:
 *
 *   0x05D -> CHARACTERS     poke 0 or 12-15 and `spec` is null/undefined, so
 *                           the next tick() throws on `spec.sleepHour`, and
 *                           feed()/playGame()/medicine() throw on the stat
 *                           block. On an EGG it survives to the hatch and
 *                           throws there instead, in becomeCharacter()'s
 *                           `CHARACTERS[prev].name`. Hence no `alive` test:
 *                           there is no stage at which the value is safe.
 *   0x050 -> GROWTH_CHARTS  poke 7-14 and the next evolution throws in
 *                           evolve(), which indexes the chart before scanning
 *                           its rows. 0xF is NOT refused in general — it is
 *                           the terminal chart every non-Maskutchi adult
 *                           carries, and mainLoopPass() gates on it before
 *                           evolve() is ever reached, so the model executes it
 *                           fine. The one moment it is refused is while
 *                           `evolutionPending` is set (#57): mainLoopPass()
 *                           queues the evolution when the timer reaches 0 and
 *                           the chart is not 0xF, and the top of the NEXT tick
 *                           consumes the flag by calling evolve() — so a 0xF
 *                           poked into that one-minute window (between ticks
 *                           is exactly where #25's panel pokes) would have
 *                           evolve() scan a chart with no rows and throw. The
 *                           predicate gets the pet as well as the value for
 *                           that reason alone; the flag clears when the
 *                           animation lands and 0xF is pokeable again.
 *
 * The ROM would have done *something* with any of these — 0x05D dispatches
 * through the 12-entry table at 0x1558 (entry 0 is Babytchi's block), and
 * label_346 dispatches on 0x050 through a seven-entry jump table
 * (0xDCB-0xDD1) that a 0xF would index off the end of — but what it does is
 * unmeasured, and the ROM cannot even reach the #57 state on its own: 0x050
 * has no writer between the queue and the animation. Guessing a behaviour here
 * would be exactly the invented constant CLAUDE.md forbids. So the model
 * refuses the poke rather than carry a state whose behaviour it would have to
 * make up. run-model.mjs reports a refused poke and stops; the RAM panel
 * leaves the cell at its old value.
 */
const POKE_TABLE_INDEXED = Object.freeze({
  0x05d: (v) => CHARACTERS[v] !== undefined,
  0x050: (v, pet) =>
    GROWTH_CHARTS[v] !== undefined || (v === 0xf && !pet.evolutionPending),
});

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export class TamaP1 {
  /**
   * @param {object} opts
   * @param {number} opts.hour   wall-clock hour at power-on (0-23)
   * @param {number} opts.minute wall-clock minute at power-on
   * @param {number} opts.seed   initial value of the 4-bit counter at 0x05A
   */
  constructor({ hour = 0, minute = 0, seed = 0 } = {}) {
    // --- clock -------------------------------------------------------------
    this.hour = hour;                 // 0x014/5
    this.minute = minute;             // 0x012/3
    this.elapsed = 0;                 // total ticks since power-on (bookkeeping)

    // --- identity ----------------------------------------------------------
    this.character = null;            // 0x05D
    this.stage = STAGE.EGG;
    this.growthChart = 0;             // 0x050

    // --- vitals ------------------------------------------------------------
    // hunger/happy are quarter-heart units 0..0xF, not hearts. See HEART_STEP.
    this.hunger = RULES.POWER_ON_HUNGER;   // 0x040
    this.happy = RULES.POWER_ON_HAPPY;     // 0x041
    this.weight = RULES.POWER_ON_WEIGHT;   // 0x046/7, decimal
    this.age = 0;                     // 0x054/5, decimal
    this.discipline = 0;              // 0x043, quarters 0-4

    // --- fault counters ----------------------------------------------------
    this.careMistakes = 0;            // 0x042, cumulative across evolutions
    this.disciplineMistakes = 0;      // 0x051, cumulative
    this.adultCareMistakes = 0;       // 0x04F, adults only, 5 = death
    this.sicknessCount = 0;           // 0x049, reset on evolution, 3 = death

    // --- flags -------------------------------------------------------------
    // 0x048 is NOT a boolean: bit 3 is the sick flag and the low 3 bits are a
    // medicine-shot counter that survives the cure. See the `sick` getter and
    // RULES.SICKNESS_ONSET_BYTE / medicine() below.                    [ROM]
    this.sickByte = 0;                // 0x048
    this.asleep = false;              // 0x04A
    this.lightsOn = true;             // 0x04B
    this.poopCount = 0;               // 0x04D
    // 0x04E: set once a final-form adult's evolution timer expires and never
    // cleared. Its only consumer is the death sequence's screen variant — it
    // is the community notes' "egg flag" under its real meaning (#22, #48).
    this.adultTimerExpiredFlag = false; // 0x04E
    // 0x208 is a counter, not a flag: 0 = not calling, 1..0xF = minutes into a
    // call, and a care mistake is booked at 0xF. See RULES.CALL_ARM.
    this.callTimer = 0;               // 0x208
    // 0x209 is the same kind of counter as 0x208, not a flag: label_107 arms it
    // at 1, label_319's second label_328 call advances it once a minute, and
    // label_382 books a DISCIPLINE mistake into 0x051 the minute it reads 0xF.
    // It also gates the meal and the game while nonzero. #29
    this.scoldTimer = 0;              // 0x209

    // --- countdowns (all in minutes unless noted) --------------------------
    this.eggTimer = RULES.EGG_MINUTES;   // 0x07C
    this.hungerTimer = RULES.POWER_ON_HUNGER_TIMER;       // 0x200/1
    this.happyTimer = RULES.POWER_ON_HAPPY_TIMER;         // 0x202/3
    this.lightsTimer = RULES.POWER_ON_LIGHTS_TIMER;       // 0x204/5
    this.poopTimer = RULES.POWER_ON_POOP_TIMER;           // 0x206/7
    this.neglectTimer = 0;                                // 0x20A-C
    this.sicknessTimer = RULES.POWER_ON_SICKNESS_TIMER;   // 0x20D-F
    this.evolutionTimer = RULES.POWER_ON_EVOLUTION_TIMER; // 0x210-2
    this.disciplineCountdown = 0;        // 0x213, counts heart decrements
    this.disciplineSkip = 0;             // 0x214
    // The baby's private sleep clock. See RULES.BABY_NAP_MINUTES: both are
    // written once at power-on and never reloaded, so they also encode "has
    // this pet already had its nap".
    this.babyNapTimer = RULES.BABY_NAP_MINUTES;       // 0x215
    this.babyAwakeTimer = RULES.BABY_AWAKE_MINUTES;   // 0x216/7

    // Main-loop events that run an animation before they touch RAM, so they
    // land later in the minute than the point both oracles sample. See tick().
    this.evolutionPending = false;
    this.poopPending = false;
    this.deathPending = false;        // 0x05C = 6, the death animation queued
    this.dying = false;               // animation's second minute; 0x05D still set
    this.deathCause = null;
    // The heart step's own `jp set_0x5C_to_a` (0x05C = 2), which ends the pass
    // before label_380. Only settlePoke() reads it — an ordinary tick merges
    // the two passes on purpose. See mainLoopPass() and #58.
    this.heartQueued = false;
    // Set by settlePoke() when the poke's settle pass owed its tail to the pass
    // after the minute-0 sample; paid at the top of the next tick(). #58
    this.settleTailOwed = false;

    // --- the stat block, 0x230-0x249 -----------------------------------------
    // RAM, not a constant table: label_347 copies the character's twelve bytes
    // out of the ROM table at 0x1564-0x15E5 into these nibbles, and every rate,
    // sleep hour, weight bound, dose and timer the ROM then reads comes back
    // out of RAM. So the model mirrors it the same way — loadStatBlock() writes
    // it at every character change and the methods below READ it, which is what
    // makes it pokeable: a scenario that pokes 0x05D and the block starts as
    // that character on both sides, and one that pokes only 0x05D keeps the old
    // block on both sides (#54, #37, #42).
    //
    // Power-on is all zeroes, and that is measured rather than assumed:
    // label_232's init block does not touch 0x230-0x249, so the reset-time RAM
    // clear is what stands there. freerun-baby reads 0x230-0x249 as 26 zero
    // nibbles for minutes 0-5 and the Babytchi's block from minute 6, the hatch
    // (#2's "no uniform inactive sentinel" applies here too).             [ROM]
    //
    // 0x234/5 and 0x236/7 are the only two the ROM ever rewrites without a
    // character change: label_363 decays them in place on the wake path once
    // the pet is a final-form adult whose evolution timer has run out. That is
    // why they are the live rates the heart pass reloads from — see
    // tickSleepTransition() and the rate-decay note above.
    this.statWakeHour = 0;            // 0x230/1, 0xFF = no wall-clock bedtime
    this.statSleepHour = 0;           // 0x232/3
    this.statHungryRate = 0;          // 0x234/5, minutes per hungry heart
    this.statHappyRate = 0;           // 0x236/7
    this.statSicknessTime = 0;        // 0x238-A
    this.statMedicineDose = 0;        // 0x23B
    this.statMinWeight = 0;           // 0x23C/D, BCD
    this.statMaxWeight = 0;           // 0x23E/F, BCD
    this.statEvolutionTime = 0;       // 0x240-2
    this.statDisciplineReload = 0;    // 0x243, the reload for 0x213
    this.statInitialDiscipline = 0;   // 0x244, the reload for 0x043
    this.statGameWinByte = 0;         // 0x245
    this.statGameDelayWin = 0;        // 0x246
    this.statGameDelayLose = 0;       // 0x247
    // 0x248/9 are the block's `retd` byte. Its low nibble is the feeding
    // animation's bite count in the ROM's own encoding (0 = 4 bites, 1 = 2),
    // and its high nibble is 0 in all ten blocks — nothing reads either, but
    // the ROM writes both and the diff compares both.                    [ROM]
    this.statBitesByte = 0;           // 0x248
    this.statRetdHigh = 0;            // 0x249

    // --- rng ---------------------------------------------------------------
    // 0x05A is a free-running 4-bit counter incremented by the programmable
    // timer interrupt, NOT a PRNG. It is fully deterministic given identical
    // timing. Its rate is now measured: ~2194.29 increments a minute, i.e. the
    // 256 Hz prescaler divided by the reload of 7 the ROM writes to 0xF26 at
    // ROM 0x11EA, and both emulator cores reproduce it (#15).
    //
    // rngPerMinute stays 1 on purpose. 2194.29 is not an integer and the field
    // is 4 bits wide, so a once-a-minute model cannot land on the ROM's value
    // whatever number goes here — `rng` is in fields.mjs's DEFAULT_IGNORE and
    // the guessing game is replayed from the oracle instead (--games, #13).
    // 1 is a placeholder that keeps the counter moving for the UI; it is NOT a
    // claim about the ROM, which is why the tag stays [UNKNOWN].
    this.rng = seed & 0xf;
    this.rngPerMinute = 1;                                        // [UNKNOWN]

    this.log = [];

    /**
     * THE PASS/INTERRUPT RACE, REPLAYED (#38, #40).
     *
     * Four collisions in the ROM's main loop are decided by where the clock
     * interrupt lands inside a main-loop pass. Nothing in RAM predicts them, so
     * the model cannot: at a one-minute time base the phase they turn on does
     * not exist. The three knobs below (`*_STARVES_HEART_PASS`) pick one side
     * of each coin and are wrong whenever the ROM landed the other way.
     *
     * `raceHints` is the way out, and it is the same one --games took for the
     * rng: the ORACLE watches the ROM's own program counter and reports how far
     * each straddled pass got, and the model replays that instead of guessing.
     * Set it to an object per tick — `{sleep:{reach,svc}, poop:{...},
     * evolution:{...}}` — and each decision below reads its landing from there.
     * `null`, the default, means "no replay": every decision falls back to its
     * [INFERRED] knob and the model behaves exactly as it did before.
     *
     * `reach` is not a boolean, because the bedtime collision has three
     * measured landings (#4/#38): 0 the pass never reached the heart step,
     * 1 it reached it and read both timers on the STALE side of the interrupt
     * so nothing reloaded, 2 it reloaded. `svc` says whether the pass got as
     * far as label_380, the request-and-service tail. See raceLanding().
     */
    this.raceHints = null;
    /** Decisions faced under replay that the oracle logged nothing for. */
    this.raceUnhinted = [];
    /**
     * Thunks to run inside the next tick(), after the animation catch-up and
     * before the minute's interrupt — where a button press can actually land
     * on the ROM. A caller that acts immediately (index.html's buttons, a test)
     * leaves this empty and nothing changes; run-model.mjs queues its policy
     * and `actions` calls here. See drainPendingActions() and #56.
     */
    this.pendingActions = [];
  }

  // -- helpers -------------------------------------------------------------

  /**
   * How far the ROM's straddling pass got at this collision, from the oracle's
   * report if we are replaying one and from the [INFERRED] knob otherwise.
   *
   * A decision the oracle logged nothing for is recorded rather than silently
   * defaulted — exactly like a game the score log has no entry for. It means
   * the two sides disagree about WHEN the collision happened, which is a real
   * finding and not an rng artefact.
   */
  raceLanding(kind, fallback) {
    if (this.raceHints === null) return fallback;
    const hit = this.raceHints[kind];
    if (hit) return hit;
    // elapsed is incremented at the top of tick(), so the tick index — the
    // minute run-model.mjs keyed the hints by — is one less.
    this.raceUnhinted.push({ t: this.elapsed - 1, kind });
    return fallback;
  }

  /**
   * Did the oracle report a one-off EVENT of this kind for this minute?
   *
   * raceLanding() above is for a collision the model can see coming and has to
   * resolve — it faces the decision every time, so a missing hint is a finding
   * and gets recorded. This is the other shape: an event the model has no way
   * of knowing is even possible, because the quantity that produces it is not
   * in the model's state at all. `sleepwrap` is the one instance — the sleep
   * sprite's frame counter in the low nibble of 0x04A wrapping under the clock
   * interrupt, which the model does not simulate and `fields.mjs` does not
   * compare (#6). There is no decision faced and no fallback worth reporting,
   * so a minute with no record is simply a minute it did not happen in. See
   * the detector comment in tamalib_trace.c (#56).
   */
  raceFlag(kind) {
    return this.raceHints !== null && !!this.raceHints[kind];
  }

  /**
   * The character's ROM stat table entry — the SOURCE the block at 0x230-0x249
   * is copied from, not the block itself. The block is RAM and lives in the
   * `stat*` properties; this is label_347's jump-table target. Null before the
   * hatch and again over a corpse — both states `alive` already excludes, and
   * both legitimate — and `undefined` for a character id with no CHARACTERS
   * entry, which is not legitimate at all.
   *
   * MODEL INTEGRITY, NOT A ROM RULE, and the anchor for the `!this.spec` guards
   * below: a LIVE pet whose 0x05D indexes no entry here is a state the model
   * cannot execute, because the next character change reads `spec.stage` and
   * `CHARACTERS[prev].name` off it. It used to be reachable two ways and both
   * threw a TypeError where the ROM would have done something — a raw
   * `pet.stage = STAGE.CHILD` on an unhatched pet, and a poke of 0x05D to 0 or
   * 12-15 on a live one (#55, found via #23's DOM stub and reachable from #42's
   * poke block and #25's RAM panel). pokeRam() now refuses to create it (see
   * POKE_TABLE_INDEXED) and the three action methods keep their guard, which
   * turns the crash into the same "the ROM refused" false the other guards
   * return. Those three no longer strictly need it — since #54 they read the
   * RAM block like the ROM does — but the refusal is still the honest answer
   * for a pet the model cannot evolve.
   */
  get spec() {
    return this.character ? CHARACTERS[this.character] : null;
  }
  /**
   * 0x048 bit 3, not the whole byte. label_191/192 (0x600-0x61B) clear bit 3
   * during the injection animation and OR it back before adding the dose, so
   * the low 3 bits are a shot counter with a residue that outlives the cure —
   * see medicine() and RULES.SICKNESS_ONSET_BYTE.                    [ROM] #32
   */
  get sick() {
    return (this.sickByte & 0x8) !== 0;
  }
  get alive() {
    return this.stage !== STAGE.DEAD && this.stage !== STAGE.EGG;
  }
  /**
   * 0x234/5 and 0x236/7, the live rates the heart pass reloads from. Plain
   * aliases for the RAM nibbles since #54 — there is no fallback to CHARACTERS
   * any more, because a poked 0 at 0x234 means the ROM reloads 0x200 with 0 and
   * the model has to do the same.
   */
  get hungryRate() {
    return this.statHungryRate;
  }
  get happyRate() {
    return this.statHappyRate;
  }
  /** 0x209 read as a yes/no, for the UI and the policy layer. */
  get needsScolding() {
    return this.scoldTimer !== 0;
  }
  /** Hearts as the LCD draws them: 0x040/0x041 are quarter-heart units. */
  get hungerHearts() {
    return Math.ceil(this.hunger / RULES.HEART_STEP);
  }
  get happyHearts() {
    return Math.ceil(this.happy / RULES.HEART_STEP);
  }
  emit(event, detail = {}) {
    this.log.push({ t: this.elapsed, hour: this.hour, minute: this.minute, event, ...detail });
  }

  // -- lifecycle -----------------------------------------------------------

  /**
   * label_391 (0xFEC), reached from the main loop at label_158 when 0x07C hits
   * 0. Parks 0x07C at 0xF, writes the character, and falls into label_347 which
   * loads the 0x230-0x249 stat vector. It deliberately does NOT touch the
   * hunger, happy or poop timers — those still hold their power-on values, and
   * 0x200 holding 0 is exactly what costs the newborn its first quarter heart.
   */
  hatch() {
    this.eggTimer = RULES.EGG_HATCHED;                              // [ROM]
    this.becomeCharacter(CHAR.BABYTCHI, 0);
    this.emit("hatch");
  }

  becomeCharacter(id, chart) {
    const prev = this.character;
    this.character = id;
    this.growthChart = chart;
    const s = CHARACTERS[id];
    this.stage = s.stage;

    // The twelve `lbpx` writes plus the `retd`: 0x230-0x249 now hold THIS
    // character's block, and everything below reads the block rather than the
    // table — which is what the ROM does too, and why the order matters.
    this.loadStatBlock(s);
    // label_350 (0xDFE-0xDFF) tail-jumps into label_214, the universal
    // two-sided weight clamp, with 0x230-0x247 already reloaded — so the
    // carried-over weight is clamped into the NEW character's [0x23C/D,
    // 0x23E/F] window, down as well as up (#53; see the rule's comment).
    //                                                                    [ROM]
    this.weight = Math.max(this.weight, this.statMinWeight);
    if (RULES.CHARACTER_CHANGE_CLAMPS_WEIGHT_DOWN)
      this.weight = Math.min(this.weight, this.statMaxWeight);
    this.evolutionTimer = this.statEvolutionTime;
    // label_347 reads 0x048 before its copies, and `fan a, 0x8` (0xDEA) skips
    // the 0x238-A -> 0x20D-F reload when bit 3 is set: a pet that evolves
    // while sick keeps its running sickness counter (which counts up while
    // sick). Measured at minute 71 of freerun-baby: 0x20D-F reads 16 — the
    // count since falling ill at 55 — not Marutchi's reload. The evolution
    // timer copy sits before the test and always happens.               [ROM]
    if (!this.sick) this.sicknessTimer = this.statSicknessTime;
    // 0x213 <- 0x243 (label_348, 0xDF0). A character with no countdown carries
    // 0xF there, so the mirror is 0xF and not 0.                       [ROM]
    this.disciplineCountdown = this.statDisciplineReload;

    // label_348/349 (0xDF7): 0x043 is loaded from 0x244, then overwritten
    // with 8 (= 50%, 2 quarters) when the NEW chart is 2 or 4 — the type-1
    // teens. The 8 is label_349's own literal and is NOT in the stat block,
    // which is why it is still read off the table here (#37).           [ROM]
    this.discipline =
      chart === 2 || chart === 4
        ? (s.initialDisciplineType1 ?? this.statInitialDiscipline)
        : this.statInitialDiscipline;

    // Sickness count resets on evolution.                             [ROM]
    this.sicknessCount = 0;
    // The heart timers are NOT reloaded here: label_347 copies 0x238-A and
    // 0x240-2 into the sickness and evolution timers and leaves 0x200/0x202
    // alone. They are reloaded by expireHeartTimers() when they read 0, which
    // by then picks up the NEW character's rate — measured at minute 71 of
    // freerun-baby, where 0x200 goes straight from 0 to Marutchi's 50.  [ROM]

    if (prev !== null) this.emit("evolve", { from: CHARACTERS[prev].name, to: s.name });
  }

  /**
   * label_347's twelve `lbpx mx,<byte>` and the block's closing `retd`: copy
   * one character's ROM stat table entry into RAM 0x230-0x249. This is the ONLY
   * writer of the block in the ROM apart from label_363's in-place rate decay,
   * which is why a poke of 0x05D on its own leaves the previous character's
   * block standing on hardware and in the model alike (#42, #54).
   *
   * The three `??` sentinels are the ROM's own bytes, not the model's nulls:
   * a character with no wall-clock bedtime carries 0xFF in both hour bytes and
   * one with no discipline countdown carries 0xF at 0x243. `bites` is the one
   * value CHARACTERS keeps in a friendlier encoding than RAM does — 4 or 2
   * bites, against the ROM's 0 or 1 at 0x248 — so it is converted here rather
   * than duplicated into the table.                                      [ROM]
   */
  loadStatBlock(s) {
    this.statWakeHour = s.wakeHour ?? RULES.SLEEP_CLOCK_OFF;        // 0x230/1
    this.statSleepHour = s.sleepHour ?? RULES.SLEEP_CLOCK_OFF;      // 0x232/3
    // The rates go in at their published base: label_363 decays 0x234-7 in
    // place, so a new character always starts fresh however far the previous
    // one's had decayed.
    this.statHungryRate = s.hungryRate;                             // 0x234/5
    this.statHappyRate = s.happyRate;                               // 0x236/7
    this.statSicknessTime = s.timeToSickness;                       // 0x238-A
    this.statMedicineDose = s.medicineDoseByte;                     // 0x23B
    this.statMinWeight = s.minWeight;                               // 0x23C/D
    this.statMaxWeight = s.maxWeight;                               // 0x23E/F
    this.statEvolutionTime = s.timeToEvolution;                     // 0x240-2
    this.statDisciplineReload =
      s.disciplineCountdown ?? RULES.DISCIPLINE_COUNTDOWN_OFF;      // 0x243
    this.statInitialDiscipline = s.initialDiscipline;               // 0x244
    this.statGameWinByte = s.gameWinByte;                           // 0x245
    this.statGameDelayWin = s.gameDelayWin;                         // 0x246
    this.statGameDelayLose = s.gameDelayLose;                       // 0x247
    this.statBitesByte = s.bites === 2 ? 1 : 0;                     // 0x248
    this.statRetdHigh = 0;                                          // 0x249
  }

  /**
   * label_112 (0x34B), the whole of what a queued evolution does. There is no
   * stage test anywhere on this path and there never was: label_112 plays the
   * animation, calls label_346 (0xDC6) to stage the current chart's table,
   * scans it at label_113 and writes the winner at label_115. The "adults do
   * not evolve" behaviour is entirely upstream, in label_372's `cp mx,0xF` on
   * 0x050 — which is why it lives in mainLoopPass() and not here, and why an
   * ADULT with a chart that is not 0xF evolves exactly like a child does.
   *
   * That adult is the type-2 Maskutchi and nothing else: label_342's third row
   * (0xDB6, `lbpx mx,0x20` / `lbpx mx,0x76`) is the only row in any chart that
   * writes a new chart other than 0xF, and it writes 6. Chart 6's table is
   * label_345 (0xDC4): a single `lbpx mx,0x00` / `retd 0xBF` — one row,
   * [care >= 0, disc >= 0, chart 0xF, char 0xB] — so the scan below cannot
   * miss and the answer is always Bill, at whatever care and discipline the
   * pet happens to carry. Bill is chart 0xF, so it is the end of the line
   * (#21).                                                               [ROM]
   *
   * Only mainLoopPass() calls this, and only with a chart that is not 0xF, so
   * the `find` below always has a table to scan. The ROM has no guard either:
   * label_346's jump table (0xDCB-0xDD1) has seven entries, and a 0x050 of 0xF
   * would index off the end of it. The invariant is held at the poke layer
   * too: pokeRam() refuses a 0xF while `evolutionPending` is set (#57), the
   * one-minute window between mainLoopPass() queueing the evolution and the
   * next tick() consuming it here, since the ROM cannot be in that state
   * (0x050 has no writer inside the window) and the model does not invent a
   * behaviour for it. So the chart indexed here always has rows.
   */
  evolve() {
    // label_113 (0x35D): scan the chart's rows against 0x042 and 0x051,
    // first row whose both thresholds are met wins.                    [ROM]
    const row = GROWTH_CHARTS[this.growthChart].find(
      (r) => this.careMistakes >= r.care && this.disciplineMistakes >= r.disc
    );
    this.becomeCharacter(row.to, row.chart);
  }

  die(cause) {
    this.stage = STAGE.DEAD;
    this.evolutionPending = false;
    this.poopPending = false;
    this.emit("death", { cause, age: this.age });
  }

  /**
   * Run and clear the deferred action queue — see the long comment at the drain
   * point in tick(). Called there, and on every early return out of tick() so a
   * queued action can never leak into the next minute.
   */
  drainPendingActions() {
    const acts = this.pendingActions;
    this.pendingActions = [];
    for (const act of acts) act();
  }

  // -- the one-minute tick -------------------------------------------------

  tick() {
    this.elapsed++;
    this.rng = (this.rng + this.rngPerMinute) & 0xf;

    // wall clock. The age does NOT increment here — it increments on waking,
    // in tickSleepTransition().
    if (++this.minute >= 60) {
      this.minute = 0;
      if (++this.hour >= 24) this.hour = 0;
    }

    if (this.stage === STAGE.DEAD) {
      this.tickDead();
      this.drainPendingActions();
      return;
    }

    // A ROM minute has two halves and the oracles sample between them.
    //
    // The clock interrupt (label_314, 0xC82) fires on the minute boundary and
    // decrements every counter. The main loop reacts afterwards, reloading
    // whatever reached 0. Most of that reaction is instant, so it lands well
    // inside the 1000 ms both adapters sample at — but the hatch, an evolution
    // and a poop each play an animation first, and their RAM writes do not
    // appear until the following minute's record. Measured three times in
    // freerun-baby: 0x07C reads 0 at minute 5 and 0xF at minute 6; 0x206/7
    // reads 0 with 0x04D still 0 at minute 20, then 0x18 with 0x04D = 1 at
    // minute 21; 0x210-2 reads 0 with 0x05D still 1 at minute 70, then 0x563
    // with 0x05D = 2 at minute 71. In all three the minute's heart pass is
    // starved too, which is why 0x200 sits at 0 in those records instead of
    // reloading.
    //
    // So: animated main-loop work carried over from the previous minute runs
    // first, then this minute's interrupt, then the instant part of this
    // minute's main loop. That ordering is the ROM's own control flow, not a
    // reconstruction from where the writes land (#68):
    //
    //   * The decrements are the interrupt's. The timer ISR calls label_312
    //     (0xC7A) at 0x148, which gates on 0x07C and falls into label_314
    //     (0xC82); every counter pass hangs off that.
    //   * The main loop's per-minute pass is label_357 (0xF00), called from
    //     label_162 at 0x52D. It exits through label_385 (0xFD6), which
    //     re-tests 0x05C and returns that flag, and the caller jumps to
    //     label_165 (0x54A) on NZ — so a queued animation is dispatched by
    //     jump_table_0x300 (0x307), which reads 0x05C, clears it and jumps to
    //     the handler.
    //   * Queueing one ends the pass. label_374 (0xF80) reaches
    //     set_0x5C_to_a (0xFD4), which writes 0x05C and falls straight into
    //     label_385 — label_375's sickness arm and label_376+'s heart pass
    //     never run that minute. That is why 0x200 sits at 0 in the three
    //     records above instead of reloading.
    //   * The handler plays the frames BEFORE it writes RAM. label_109 (0x329)
    //     calls label_124 -> label_273, the blocking frame player, at 0x32F,
    //     and only reloads 0x206/7 at 0x337 and bumps 0x04D at 0x33E once it
    //     returns. So the writes land seconds later, past the sample the
    //     adapters take on the minute — which is the carry-over.
    //   * That they land before the NEXT minute's interrupt rather than after
    //     it is what the 0x206/7 measurement pins: minute 21 reads 0x18 = 24,
    //     the 25-minute reload with that minute's decrement already taken off
    //     it, not the bare 25.                                          [ROM]
    let animated = false;
    // Egg-ness is 0x07C, not a stage variable: label_312 (0xC7A) gates the
    // whole game tick on the countdown reading 0xF, which is what the hatch
    // parks it at and what it stays at for the rest of the pet's life and over
    // its corpse. The model used to gate on `stage === STAGE.EGG` instead,
    // which is the same thing for every unpoked run — 0x07C counts 5..0 exactly
    // once and is 0xF ever after — but not for a poked one: a scenario that
    // pokes 0x07C to 0xF to start mid-life got fifteen more minutes of egg and
    // then a Babytchi hatch on top of its poked character, where the ROM runs
    // the poked character from minute 0 (measured, #54).                 [ROM]
    if (this.eggTimer !== RULES.EGG_HATCHED) {
      // 0x07C decrements while it is 1..14 and does nothing at 0; the hatch
      // itself is the main loop's job, one minute after it lands on 0.
      if (this.eggTimer > 0) {
        this.eggTimer--;
        this.drainPendingActions();
        return;
      }
      this.hatch();
      animated = true;
    } else {
      // The death animation spans two minutes, staggered like every other
      // animated event. The gate fires at minute T (checkDeath, 0x05C = 6);
      // at T+1 the animation's first writes land before the interrupt —
      // 0x048 and 0x04D are cleared, which is why the sickness counter walks
      // ONE healthy decrement (352 -> 351) in the same record that shows the
      // sick flag dropping; at T+2 0x05D is cleared and the pet is a corpse.
      // Measured in freerun-baby (407/408/409) and lights-care-mistake
      // (1177/1178/1179), where 0x048/0x04D and 0x05D fall a minute apart
      // on both cores.                                                 [ROM]
      if (this.dying) {
        this.dying = false;
        this.character = null;
        this.die(this.deathCause);
        this.tickDead();
        this.drainPendingActions();
        return;
      }
      if (this.deathPending) {
        // label_116 writes 0x048 = 0, 0x049 = 0, 0x04A = 0, 0x04B = 0xF,
        // 0x04C = 0, 0x04D = 0 — see applyDeathAnimationWrites().
        this.applyDeathAnimationWrites();
      }
      if (this.evolutionPending) {
        this.evolutionPending = false;
        this.evolve();
        animated = true;
      }
      if (this.poopPending) {
        this.poopPending = false;
        this.dropPoop();
        animated = true;
      }
    }
    if (animated) {
      // The carried-over main-loop pass that finishes an animation re-runs the
      // sleep check before anything else (label_357 -> label_364/365), and
      // falling asleep sets 0x05C, which stops the pass before the heart pass.
      // So a pet that evolves inside its new character's sleep window goes to
      // sleep in the catch-up pass and its heart timers are never reloaded.
      // Measured at minute 71 of lights-care-mistake: 0x04A is set and 0x204/5
      // reads 1 (the bedtime reload plus this minute's interrupt increment),
      // and TamaLIB's 0x200 freezes at 0 for the whole night. NB: MAME instead
      // shows 0x200 reloaded to 3 at this exact boundary (#4) — the model
      // follows the 0x05C reading of the asm, which is TamaLIB's side. [ROM]
      //
      // AND IF IT DOES NOT FALL ASLEEP IT RUNS THE WHOLE REST OF THE PASS, not
      // just the heart step. There is no "catch-up" special case in the ROM:
      // the animation dispatcher clears 0x05C and the next ordinary main-loop
      // pass runs label_357 top to bottom, so label_380's discipline request
      // and label_381/382's counter services are as much a part of it as
      // label_376's reload. Measured at minute 4874 of maskutchi-bill, with the
      // detector's PC log: the first pass of the window queues the poop at
      // +14,049 ticks, the animation runs for 260,653 more, and the pass at
      // +274,702 reloads 0x200, decrements 0x213 to 0 at label_377 and reaches
      // label_380 at +275,715, which reloads 0x213 to 6 and asks for a
      // scolding — all inside window 4874. The model, running only the heart
      // step here, did not ask until the next tick, so 0x209 armed a minute
      // late and stayed a minute behind for 15 minutes, dragging the blocked
      // meal (label_223 refuses while 0x209 is pending, #34) with it. That is
      // the whole of [#40](../../issues/40), and it is a rule the model was
      // missing rather than a coin: with this line the run is bit-exact.  [ROM]
      this.tickSleepTransition();
      if (!this.asleep) {
        this.fallSickIfDue();         // label_375
        this.expireHeartTimers();     // label_376/378
        this.tickDisciplineRequest(); // label_380
        this.serviceAttentionCall();  // label_381
        this.serviceScoldCall();      // label_382
        // ...and the NEXT pass through label_367, in the same window. The
        // catch-up pass runs early — the animation it finished was queued by
        // the first pass after the interrupt — so there is most of a minute
        // left for that next pass, and for the death animation it may start.
        //
        // Measured over poop-pileup's window 2895, the third-sickness death,
        // with the per-instruction change watcher:
        //
        //   + 196.4 ms  0x05C 0 -> 4      label_374 queues the poop
        //   +7584.0 ms  0x206/7, 0x04D    label_109/110 finish the animation
        //   +7602.1 ms  0x20D-F -> 0      the eighth-poop zeroing
        //   +7737.8 ms  0x048 -> F, 0x049 2 -> 3   label_375, the catch-up pass
        //   +8611.6 ms  0x05C 0 -> 6      label_371 — the NEXT pass's gate
        //   +11678.5ms  0x048/0x049/0x04D cleared  label_116 at pc 0x037B
        //   +59327.2ms  the boundary interrupt
        //
        // So the gate AND its animation both complete inside the window the
        // catch-up pass belongs to, and the clears land in the very next
        // record rather than the one after it. That is the whole difference
        // between the model's death at 2897 and the ROM's at 2896 (#56).
        this.checkDeath();
        if (this.deathPending) this.applyDeathAnimationWrites();
      }
    }
    /*
     * DEFERRED ACTIONS — where a minute's button presses actually land.
     *
     * A caller that drives the pet through a policy (run-model.mjs, and the
     * adapter's apply_policy mirroring it) DECIDES from the minute's record and
     * then acts. On the ROM the acting cannot start until the ROM is listening,
     * and it is not listening while an animation is playing: label_162's input
     * loop does not run, and every press is dropped. So an action in a minute
     * that finishes an animation lands AFTER that animation's RAM writes, not
     * before them.
     *
     * Measured at minute 70 of tended-week — the evolution minute — with a
     * per-instruction change watcher, positions in ms into window 70:
     *
     *   + 6929.9  0x050 = 1, 0x05D = 2   label_115, the evolution's chart
     *   +10539.3  0x046/7 = 10           the new character's stat vector
     *   +10752.3  0x075 0 -> 1           the feed macro's FIRST press to land
     *   +12288.0  0x040 8 -> C           the meal
     *   +12291.3  0x046 0 -> 1           and its +1: weight 11, not 10
     *
     * Applying the meal before the catch-up puts the +1 under the stat vector's
     * overwrite and reads 10. So the queue is drained here: after the carried-
     * over pass, before this minute's interrupt. It is a list of thunks rather
     * than a list of verbs because the DECISIONS still belong to the record —
     * the adapter's policy reads RAM 1.5 s into the window, ahead of the
     * animation, exactly as the model's reads the record it just dumped (#56).
     */
    // And before them, the tail settlePoke()'s truncated pass owed (#58). The
    // ROM ran it in the pass after the minute-0 sample — 1570 ms in, ahead of
    // the minute-1 interrupt below and ahead of anything a minute-0 macro can
    // press, since the macros do not start until 1500 ms and have a cursor to
    // walk. When an animation was what truncated the pass, the catch-up above
    // has already run label_380/381/382 for this minute and the debt is paid.
    if (this.settleTailOwed) {
      this.settleTailOwed = false;
      if (!animated) this.mainLoopPassTail();
    }
    this.drainPendingActions();

    if (this.stage === STAGE.DEAD) return;

    // The interrupt half, label_314 (0xC82). The very first thing it does is
    // test 0x04A bit 3, and the asleep arm services one counter and RETURNS —
    // it never reaches the per-minute pass at label_319. So sleep freezes
    // every game timer there is, not just the hearts: hunger, happy, poop,
    // sickness, evolution, 0x208 and the neglect counter all hold still.
    // Measured over the 769-minute night of lights-care-mistake and over the
    // Babytchi nap of freerun-baby, on both cores (#7, #8).              [ROM]
    // ...unless the sleep sprite's frame counter wrapped through 0 in the one
    // instruction between jp_copy_buf_misc's `add mx,0x1` and its `or mx,0x8`,
    // and the interrupt landed there. label_314 then reads 0x04A with bit 3
    // out, takes the awake arm, and a sleeping pet runs one whole label_319.
    // The model cannot see that coming — the low nibble of 0x04A is not
    // modelled — so the oracle reports it and raceFlag() replays it. Measured
    // at lights-left-on 3845; see the detector comment in tamalib_trace.c
    // and raceFlag() above (#56).                                       [ROM]
    if (this.asleep && !this.raceFlag("sleepwrap")) {
      this.tickSleepCounters();
    } else {
      // label_314 read 0x04A with bit 3 out, so every test of it downstream in
      // this pass reads awake too — and decayHeartTimers(), tickCare() and
      // tickSickness() each carry their own copy of that gate. Lift the flag
      // for the pass and put it back, exactly as the bedtime straddle does:
      // the ROM has not written 0x04A, it has merely been read wrong, and the
      // main-loop half a fraction of a second later reads it right again.
      const wasAsleep = this.asleep;
      this.asleep = false;
      this.tickBabyAwakeTimer();
      this.decayHeartTimers();
      this.tickCare();
      this.tickSickness();
      this.tickPoop();
      this.tickEvolution();
      this.asleep = wasAsleep;
    }

    // The main-loop half. label_357 (0xF00) re-reads 0x04A, so a pet that has
    // just woken gets the rest of the main loop in the same minute — the main
    // loop runs many times a second and only the pass that did the waking
    // jumped out. Falling asleep is different: label_366 leaves 0x05C set, and
    // every later pass that minute stops at label_357's `0x05C == 0` gate.
    // Both are visible around the nap of freerun-baby, where the poop timer
    // reaches 0 at minute 45, is not dropped until the pet wakes, and lands at
    // minute 51 — queued by the second main-loop pass of minute 50.      [ROM]
    //
    // The dying minute is skipped whole: 0x05C = 6 holds through the death
    // animation, so no pass gets past label_357 — no sleep check, no poop
    // queue, no heart pass, no bookings.                                 [ROM]
    if (!this.dying) {
      const wasAwake = !this.asleep;
      const lightsBefore = this.lightsTimer;
      this.tickSleepTransition();
      // A pet that fell asleep in THIS pass: label_366 leaves 0x05C set and
      // every later pass that minute stops at label_357's gate, so the heart
      // pass is skipped. Except when the interrupt lands mid-pass and it is
      // not — see RULES.SLEEP_STARVES_HEART_PASS and raceLanding().
      //
      // This is the collision with three landings (#4, #38). The pass reads the
      // hour at label_357's top (0xF0B) — or, for a baby's nap, the counter at
      // 0x216/7 — and the heart timers 130 instructions later, so an interrupt
      // landing between them leaves a pass that is awake by the old reading and
      // takes its counters from either side of the new minute:
      //
      //   reach 0  no pass got past label_367 — 0x200 stays at the interrupt's
      //            0 and 0x208 at its saturated 0xF
      //   reach 1  an awake pass ran the body but reloaded nothing. Either it
      //            stopped at a queue first (tended-neglect 44: a poop drops
      //            and only the NEXT pass reads the nap timer as run out), or
      //            it read 0x200 STALE and carried on to label_381, which read
      //            0x208 as 0xF and zeroed it — measured at lights-care-mistake
      //            70 under two of 64 perturbations, 0x200/0x208 = 0/0.
      //   reach 2  an awake pass ran and reloaded — 0x200 = 3, and the empty
      //            meter re-armed 0x208 to 0xD, which truncates the pass before
      //            the tail (svc 0). Measured under three of the 64.
      //
      // No knob can express landing 1, which is why the fallback below is only
      // ever the two the boolean has. What the model replays is the ROM's own
      // shape: an ordinary awake pass, run with the sleep flag lifted, because
      // the ROM's pass had not set 0x04A either — that is the 0x05C = 1
      // animation's job, one pass later.
      if (this.asleep && wasAwake) {
        const race = this.raceLanding("sleep",
          RULES.SLEEP_STARVES_HEART_PASS ? RACE_STOPPED : RACE_RAN);
        if (race.reach >= 1) {
          this.asleep = false;
          const hadQueue = this.evolutionPending || this.poopPending;
          this.checkDeath();
          if (!this.deathPending) this.mainLoopPass(race.reach < 2, !!race.svc);
          // ...and if that awake pass queued an animation, the bedtime pass ran
          // AFTER it, so 0x04A is not written until the animation ends — which
          // is past the next sample. Measured at tended-neglect 44: an awake
          // pass drops the Babytchi's poop, the ROM's record 45 still reads
          // awake with 0x204/5 at 0xFF, and 0x04A and the 0x3D bedtime reload
          // only appear at 46. So undo the transition here and let the next
          // tick's sleep check — which runs after the same animation catch-up —
          // make it again. Every other bedtime queues nothing and is unaffected.
          if (!hadQueue && (this.evolutionPending || this.poopPending)) {
            this.lightsTimer = lightsBefore;                            // [ROM]
          } else {
            this.asleep = true;
          }
        }
      }
      if (!this.asleep) {
        // label_367 (0xF5B): the death gate sits between the sleep check and
        // the rest of the pass; firing jumps straight to set_0x5C_to_a, so the
        // trigger minute's poop queue and heart pass never run.          [ROM]
        this.checkDeath();
        if (!this.deathPending) this.mainLoopPass();
      }
    }
  }

  /**
   * The rest of the awake main-loop pass, label_372 to label_382 (0xF76-0xFD3),
   * in the ROM's order. Every step that queues an animation does it with
   * `jp set_0x5C_to_a`, which RETURNS from the pass — so a queued evolution
   * suppresses the poop queue, and either suppresses the heart pass and both
   * counter services downstream of it. Measured at minute 70 of freerun-baby:
   * 0x208 saturates at 0xF with the evolution queued and the ROM leaves it
   * sitting there; the next minute's catch-up discards it before the
   * post-evolution re-arm.                                               [ROM]
   *
   * `stale` and `tail` exist only for the bedtime race replay above, where the
   * ROM ran this body in a pass that had already read the heart timers from
   * before the interrupt (`stale`) or that jumped out at `set_0x5C_to_a` before
   * label_380 (`tail` false). An ordinary awake pass takes the defaults, which
   * are the behaviour every bit-exact scenario was measured against: running
   * the tail unconditionally is right there because the next pass, half a
   * second later, runs it anyway — but a pet that is going to sleep has no next
   * awake pass, so the bedtime replay has to say.
   *
   * `noStraddle` says there is no clock interrupt in front of this pass, so
   * neither queue below can be straddling one and there is nothing to replay:
   * both truncate the pass literally, the way the ROM's `jp set_0x5C_to_a`
   * does. Only settlePoke() passes it — see there (#58).
   *
   * Returns true if the pass ran to the end, false if a queue truncated it.
   */
  mainLoopPass(stale = false, tail = true, noStraddle = false) {
    // label_372/373: an expired evolution timer either queues the evolution
    // animation (0x05C = 5) or, for a final-form adult (0x050 == 0xF), sets
    // the timer-expired flag at 0x04E and falls straight through. The adult arm
    // does NOT reload the timer — it stays at 0 for the rest of the pet's
    // life, which is what arms the 0x04F booking in label_388 and the rate
    // decay in label_360. Measured at minute 14785 of tended-longlife, where
    // 0x04E goes to 0xF and 0x210-2 stays 0 (#35).
    //
    // The test is `cp mx,0xF` on 0x050 followed by `jp nc` — a chart test, not
    // a stage test, and the ONLY thing separating "evolves" from "stops here".
    // A type-2 Maskutchi is an adult carrying chart 6, so it takes the SAME
    // arm a child takes and evolves into Bill when its own 0x240-2 runs out
    // (#21). No other adult can: every other chart row writes 0xF.       [ROM]
    if (this.evolutionTimer === 0) {
      if (this.growthChart === 0xf) {
        // The write is unconditional in the ROM and repeats every pass for the
        // rest of the pet's life; the event is not, or it would fire every
        // minute for days.
        if (!this.adultTimerExpiredFlag) this.emit("adultTimerExpired");
        this.adultTimerExpiredFlag = true;
      } else {
        this.evolutionPending = true;
        // The queue is `jp set_0x5C_to_a`, which returns out of the pass — so
        // the heart work happens only if an EARLIER pass in this minute already
        // did it. Measured both ways at the same minute on the same ROM:
        // freerun-baby 69 queues on the first pass of the window and the heart
        // pass does not run until the animation ends 13 s later (reach 0),
        // while poop-pileup 69 has a pass already in flight when the interrupt
        // lands, which reloads 0x200 and only then queues (reach 2).
        if (noStraddle || this.raceLanding("evolution",
          RULES.EVOLUTION_QUEUE_STARVES_HEART_PASS ? RACE_STOPPED : RACE_RAN)
          .reach === 0) return false;
      }
    }
    // label_374 (0xF80): the poop is queued by the main loop when 0x206/7
    // reads 0, not by the interrupt that decremented it there.           [ROM]
    if (this.poopTimer === 0) {
      this.poopPending = true;
      if (noStraddle || this.raceLanding("poop",
        RULES.POOP_QUEUE_STARVES_HEART_PASS ? RACE_STOPPED : RACE_RAN)
        .reach === 0) return false;
    }
    this.fallSickIfDue();                   // label_375
    if (!stale) this.expireHeartTimers();   // label_376/378
    if (tail) {
      this.mainLoopPassTail();              // label_380/381/382
    }
    // A 5th adult care mistake booked by that service is seen by the next pass
    // through label_367 in the same minute.
    this.checkDeath();
    return true;
  }

  /**
   * label_380 to label_382 (0xFB7-0xFD3), the tail of an awake main-loop pass:
   * ask for a scolding if the discipline countdown has run out, then service
   * the two attention counters. Split out of mainLoopPass() because the ROM
   * reaches it in a LATER pass whenever the heart step queued the meter-empty
   * animation, and at the poke instant that later pass falls the other side of
   * the minute-0 sample — see settlePoke() (#58).
   */
  mainLoopPassTail() {
    this.tickDisciplineRequest();           // label_380
    this.serviceAttentionCall();            // label_381
    this.serviceScoldCall();                // label_382
  }

  /**
   * settlePoke() — the main-loop pass the ROM runs between a scenario's `poke`
   * block and the minute-0 sample (#58).
   *
   * Both producers apply the poke at the same instant: the tick
   * boot_and_set_clock() re-origins as minute 0. What happens next is NOT the
   * same on the two sides, and that is the whole of #58. The ROM carries on
   * running its ordinary main loop for the 1000 ms until the sample, so a poked
   * state that is already due some work has that work in record 0; the model's
   * first main-loop pass was inside its minute-1 tick(), so the same work
   * landed in record 1 and cascaded from there. The workaround was to poke only
   * settled states. This is the pass instead.
   *
   * MEASURED, with a per-instruction PC-and-RAM watcher on the TamaLIB adapter,
   * on a reconstruction of mametchi-start's first draft (an adult Mametchi
   * poked at 0x040 = 1 / 0x200 = 0 / 0x213 = 0, i.e. a heart expiry and a
   * discipline request both due at minute 0):
   *
   *   +  769.9 ms  label_357        the FIRST main-loop pass after the poke
   *   +  859.0     0x200/1 = 0x51   label_376 reloads from the poked 0x234/5
   *   +  862.9     0x040 1 -> 0     and spends the last quarter heart
   *   +  876.5     0x05C = 2        `jp set_0x5C_to_a`: the pass ENDS here
   *   +  880.2     0x208 = 1        the animation arms the attention counter
   *   + 1000.0     ---------------- the minute-0 sample
   *   + 1435.9     label_357        the second pass
   *   + 1564.4     0x213 = 0xF      label_380 reloads it from the poked 0x243
   *   + 1570.0     0x209 = 1        and asks for a scolding
   *   +59317.7     label_312        the minute-1 clock interrupt
   *
   * So: ONE pass before the sample, and it is a literal pass — it truncated at
   * the heart step's animation queue and label_380 did not run until the pass
   * after the sample. Both halves are inside minute 0 and both are ahead of the
   * minute-1 interrupt, which is why the oracle's record 1 shows 0x209 at 2
   * (armed at 1570 ms, then advanced by the interrupt) and not at 1.
   *
   * ONE PASS, NOT TWO, AND THAT IS MEASURED PER START HOUR. The pass cadence
   * for this state is ~660-700 ms and the first pass lands 380-880 ms after the
   * poke, so the second lands 1060-1560 ms in — after the sample in all
   * thirteen of Mametchi's awake start hours (09..21). The tightest is hour 13,
   * whose second pass is at 1059 ms, 59 ms clear. The ten sleeping hours get
   * one pass that falls asleep at label_366 and returns, and any further passes
   * take label_358 and do nothing, so the count does not matter there. An
   * ordinary minute is different and gets TWO passes before its sample — the
   * minute-1 boundary is at 59317.7 ms and passes follow at 59811.9 and
   * 60763.1, both ahead of the 61000 ms sample — which is exactly why
   * mainLoopPass() merges the heart step and the tail for an ordinary tick and
   * why the settle pass must not.
   *
   * WHAT THIS IS NOT. It is not a tick: nothing decrements, the wall clock does
   * not move, and there is no clock interrupt in front of it, so the three
   * pass/interrupt straddles cannot arise and `noStraddle` makes every queue
   * truncate literally. It is the ROM's label_357 body and nothing else.
   *
   * An egg's pass returns at 0xF05, so this is a no-op for every scenario that
   * does not poke 0x07C to 0xF — which is every scenario that does not poke at
   * all, since an unpoked 0x07C counts 5..0 once and is 0xF only from the hatch
   * on. Verified by cmp: freerun-baby and snack-attack traces are byte-
   * identical with the call in place.
   *
   * The residue, deliberately not modelled because nothing reaches it: a poke
   * with BOTH heart timers at 0 and both meters below one heart truncates the
   * ROM's pass at label_376 and leaves label_378 to the pass after the sample,
   * where expireHeartTimers() runs both arms together (which is right for an
   * ordinary minute — see the note there, measured at freerun-baby 11).
   */
  settlePoke() {
    this.settleTailOwed = false;
    // label_312 (0xC7A) and label_357 (0xF05) both gate on 0x07C reading 0xF.
    if (this.eggTimer !== RULES.EGG_HATCHED) return;
    if (this.stage === STAGE.DEAD || this.dying || this.deathPending) return;
    // label_357's own 0x04A test. A pet already asleep takes label_358 and
    // every arm of that side ends in `jp label_385`; a pet that falls asleep
    // here leaves 0x05C set at label_366 and the pass ends there.
    const wasAwake = !this.asleep;
    this.tickSleepTransition();
    if (this.asleep) return;
    if (!wasAwake) return;              // woke in this pass — label_359 returns
    this.checkDeath();                  // label_367
    if (this.deathPending) return;
    this.heartQueued = false;
    const ranToEnd = this.mainLoopPass(false, false, true);
    // The heart step's no-carry arm is `jp set_0x5C_to_a` too (0x05C = 2), so a
    // pass that empties a meter never reaches label_380 either. Whatever the
    // pass owes, the ROM pays in its NEXT pass — still inside minute 0, still
    // ahead of the minute-1 interrupt, but on the far side of the sample.
    if (ranToEnd && !this.heartQueued) {
      this.mainLoopPassTail();
      this.checkDeath();              // the next pass's label_367, as ever
    } else {
      this.settleTailOwed = true;
    }
  }

  /**
   * The interrupt half of the asleep arm — label_314 at 0xC85, the whole of
   * what a sleeping P1 does with its minute.
   */
  /**
   * A dead pet's minute. label_314 never tests 0x05D, so the interrupt keeps
   * running the full awake per-minute pass over the corpse's RAM: the heart
   * timers decay against 0, the poop timer runs out and stays, the neglect
   * counter keeps climbing — 651 at minute 661 of freerun-baby, and it still
   * wraps at 0xFFF, which is what keeps oldie-strat's wrap reachable — the
   * sickness counter walks the healthy decrement down from 351, and the
   * evolution timer keeps falling (789 at 661). Only main-loop work stops:
   * nothing reloads, drops, books, sleeps or re-fires the death gate. The
   * falling-sick transition is main-loop too, so the counter hitting 0 does
   * not resurrect the sick flag.                                        [ROM]
   */
  tickDead() {
    this.decayHeartTimers();
    this.tickCare();
    if (this.sicknessTimer > 0) this.sicknessTimer--; // label_322's healthy arm
    this.tickPoop();
    if (this.evolutionTimer > 0) this.evolutionTimer--; // label_323/324
  }

  tickSleepCounters() {
    // A sleeping baby never reaches label_316: the branch at 0xC88 sends
    // 0x05D == 1 to the 0x215 decrement instead, which is why 0x204/5 sits at
    // the 0x3D bedtime wrote there for the whole nap. Measured at minutes
    // 45-49 of freerun-baby, where 0x204/5 reads 61 every one of them. [ROM]
    if (this.character === CHAR.BABYTCHI) {
      if (this.babyNapTimer > 0) this.babyNapTimer--;                     // [ROM]
      return;
    }

    // label_316 (0xC8E): two-nibble increment pinned at 0xFF. Note what is NOT
    // tested here — label_314 branches on 0x04A bit 3 alone and never looks at
    // 0x04B, so the counter runs whether the lights are on or off. Turning
    // them off does not stop it; it disarms the check below. See setLights().
    if (this.lightsTimer < RULES.LIGHTS_CLAMP) this.lightsTimer++;        // [ROM]
  }

  /** The interrupt half of the awake arm that is not shared — label_318's
   *  two-nibble decrement of 0x216/7 at 0xC9A, babies only. Note the egg is
   *  excluded for free: check_0xX5D_is_1 is false while 0x05D is 0.     [ROM] */
  tickBabyAwakeTimer() {
    if (this.character !== CHAR.BABYTCHI) return;
    if (this.babyAwakeTimer > 0) this.babyAwakeTimer--;
  }

  /**
   * label_365 (0xF53) on the awake side, label_358 (0xF17) mirrored on the
   * asleep side: bedtime is a WINDOW on the hour, not an exact-minute match.
   * label_386 (0xFD9) compares the live hour at 0x014/5 against 0x232/3 (sleep)
   * or 0x230/1 (wake) — the minute at 0x012/3 is never read — and the rule is
   *
   *     asleep iff hour >= sleepHour || hour < wakeHour
   *
   * re-evaluated on every main-loop pass. For a pet already awake when the hour
   * turns this gives the same answer an exact-minute test would; it differs
   * when the pet ARRIVES inside the window — evolves after bedtime — and the
   * ROM puts it straight to sleep. Measured at minute 71 of lights-care-mistake
   * on both cores: the pet becomes a Marutchi at 20:11 and is asleep in the
   * same record (#30). Every P1 sleep window crosses midnight, which the
   * two-sided test handles for free.                                     [ROM]
   */
  inSleepWindow() {
    // 0x232/3 and 0x230/1, straight out of the block — 0xFF is the Babytchi's
    // "no wall clock" and never matches an hour, exactly as in RAM (#54).
    return (
      this.statSleepHour !== RULES.SLEEP_CLOCK_OFF &&
      (this.hour >= this.statSleepHour || this.hour < this.statWakeHour)
    );
  }

  /**
   * The main-loop half: label_357 (0xF00) when asleep, label_364 (0xF4A) when
   * awake. Both are gated on 0x05D == 1 first, because a baby's bedtime is its
   * own pair of counters and everyone else's is the wall clock.
   */
  tickSleepTransition() {
    if (this.asleep) {
      const wake =
        this.character === CHAR.BABYTCHI
          ? this.babyNapTimer === 0                          // label_357, 0xF13
          : this.statWakeHour !== RULES.SLEEP_CLOCK_OFF &&
            !this.inSleepWindow();                           // label_358, 0xF17
      if (wake) {
        // label_359 (0xF1D): 0x04B = 0xF, 0x04A = 0. The lights counter is left
        // exactly where it was; only the next bedtime reloads it.        [ROM]
        this.asleep = false;
        this.lightsOn = true;
        // Three instructions later (0xF22) the age at 0x054/5 increments — in
        // decimal (`set f,0x4` before the add) and saturating at 99 (a carry
        // out writes a literal 0x99 back). This is the ONLY age increment in
        // the ROM: not a wall-clock hour, and no nap/night distinction —
        // whatever wakes the pet ages it, which is why a Babytchi is age 1 at
        // minute 50. Measured on both cores in freerun-baby (minute 50) and
        // lights-care-mistake (minutes 50 and 840); see #10.             [ROM]
        this.age = Math.min(this.age + 1, 99);
        // label_360 (0xF2A), three instructions later: a final-form adult
        // whose evolution timer has run out gets both live rates decayed by
        // label_363's `value -= value >> 2`. Every other pet skips it. This is
        // the whole of the "gets needier as it ages" mechanism — once per
        // wake, not once per day, and with no sickness term. #19        [ROM]
        if (this.growthChart === 0xf && this.evolutionTimer === 0) {
          this.statHungryRate -= this.statHungryRate >> 2;
          this.statHappyRate -= this.statHappyRate >> 2;
          this.emit("rateStep", { hungry: this.hungryRate, happy: this.happyRate });
        }
        this.emit("wake");
        return;
      }
      // label_361 (0xF35) is reached only when the wake comparison fails, so
      // the lights mistake is not booked on the minute the pet wakes. It is a
      // high-nibble test: fire once 0x205 reads 4..0xE, i.e. the counter has
      // reached 64, and disarm by writing 0xF to 0x205 rather than by clearing
      // it — which is why 63 becomes 240 and not 0. A baby never gets here
      // (label_357 sends 0x05D == 1 straight out).                       [ROM]
      if (this.character === CHAR.BABYTCHI) return;
      const hi = this.lightsTimer >> 4;
      if (hi !== RULES.LIGHTS_DISARMED_HI && hi >= RULES.LIGHTS_MISTAKE_HI) {
        this.lightsTimer = (this.lightsTimer & 0x0f) | (RULES.LIGHTS_DISARMED_HI << 4);
        this.addCareMistake("lights");
      }
      return;
    }

    // Awake. label_364 (0xF4C) puts a baby to sleep when 0x215 is nonzero and
    // 0x216/7 has run out; once the nap is over 0x215 is 0 for good and the
    // first test fails forever. See RULES.BABY_NAP_MINUTES. Everyone else
    // sleeps the moment the hour is inside the window (label_365).       [ROM]
    const sleep =
      this.character === CHAR.BABYTCHI
        ? this.babyNapTimer !== 0 && this.babyAwakeTimer === 0
        : this.inSleepWindow();
    if (!sleep) return;

    // label_102 (0x30C): 0x04A = 0xF, then the lights counter is reloaded —
    // 0 for a real character, 0x3D for a Babytchi.                       [ROM]
    this.asleep = true;
    this.lightsTimer =
      this.character === CHAR.BABYTCHI
        ? RULES.LIGHTS_SLEEP_RELOAD_BABY
        : RULES.LIGHTS_SLEEP_RELOAD;
    this.emit("sleep");
  }

  /**
   * The interrupt half. label_326 (0xCD2) decrements a two-nibble counter and
   * writes 0 back on borrow, so a timer sitting at 0 stays at 0.        [ROM]
   */
  decayHeartTimers() {
    // The asleep gate is the ROM's, and the interrupt half has its own copy of
    // it — label_314 (0xC82), reached once a minute from the clock interrupt at
    // 0x148:
    //
    //     label_314:  ld  x,  0x4A       // 0xC82
    //                 fan mx, 0x8        // 0xC83  Z iff bit 3 clear
    //                 jp  z,  label_318  // 0xC84  awake -> the per-minute pass
    //
    // so an asleep pet (bit 3 set, Z clear) falls into the asleep arm, which
    // does the lights counter or the baby's 0x215 and returns at label_315
    // (0xC8D) / label_317 (0xC95). It never reaches label_319 (0xCA1), whose
    // first two calls are exactly these two timers — `ld x,0x0; call label_326`
    // (0xCA1-2) for 0x200 and `ld x,0x2; call label_326` (0xCA3-4) for 0x202.
    // One gate for the whole half, not one per timer, which is what this early
    // return is.                                                         [ROM]
    if (this.asleep) return;
    if (this.hungerTimer > 0) this.hungerTimer--;
    if (this.happyTimer > 0) this.happyTimer--;
  }

  /**
   * The main-loop half. label_376/378 (0xF8D/0xFA2): a timer reading 0 is
   * reloaded from the character's rate at 0x234/0x236 and costs a quarter
   * heart, clamped at 0. Splitting it this way is not cosmetic — a combined
   * decrement-and-reload never leaves the timer observable at 0, and it cannot
   * explain the newborn, whose 0x200 is already 0 from power-on and who
   * therefore loses its first quarter heart on the hatch minute.        [ROM]
   */
  expireHeartTimers() {
    // The main-loop half has its own asleep gate, a second copy of the same
    // test on the same nibble — label_357 (0xF00), the top of the once-a-minute
    // main-loop pass:
    //
    //     ld  x,  0x4A       // 0xF0E
    //     fan mx, 0x8        // 0xF0F
    //     jp  z,  label_364  // 0xF10  awake -> bedtime, death, hearts
    //
    // Asleep falls through to 0xF11 and takes label_358 (wake-hour check) or,
    // for a baby, label_359; every arm of that side — label_359/360 (waking,
    // age, rate decay) and label_361 (the lights mistake) — ends in
    // `jp label_385`, so control never reaches label_367's death gate, let
    // alone label_376 (0xF8D) and label_378 (0xFA2). So the ROM really does
    // test 0x04A twice per minute, once on each clock, and the model's two
    // guards are those two tests rather than one test modelled twice.  [ROM]
    //
    // There is no override here any more. The bedtime race replay (#38) needs a
    // pass that runs the awake body at the minute the pet falls asleep, and it
    // gets one by lifting `asleep` for the length of that pass — which is what
    // the ROM's straddling pass actually had, since 0x04A is not written until
    // the 0x05C = 1 animation runs. Faking it here instead would have made this
    // gate a lie about the gate rather than about the pass.
    if (this.asleep) return;
    if (this.hungerTimer === 0) {
      this.hungerTimer = this.hungryRate;
      // `add mx,0xC` sets carry iff the meter held a whole heart. Only the
      // carry path reaches label_377, so the discipline countdown does NOT
      // tick on the expiry that empties a meter — the no-carry path clamps to
      // 0, sets 0x05C = 2 and returns out of the routine.                [ROM]
      //
      // That return does not skip the happy pass, though it looks like it
      // should: the main loop runs many times a second, so the next pass finds
      // 0x200 reloaded, falls through to label_378 and expires 0x202 in the
      // same minute. Measured at minute 11 of freerun-baby, where both timers
      // reload together. Modelling the return literally leaves 0x202 at 0.
      if (this.hunger >= RULES.HEART_STEP) {
        this.hunger -= RULES.HEART_STEP;
        this.onHeartDecrement();
      } else {
        this.hunger = 0;
        this.callForAttention();
      }
    }
    if (this.happyTimer === 0) {
      this.happyTimer = this.happyRate;
      if (this.happy >= RULES.HEART_STEP) {
        this.happy -= RULES.HEART_STEP;
        this.onHeartDecrement();
      } else {
        this.happy = 0;
        this.callForAttention();
      }
    }
  }

  onHeartDecrement() {
    // label_377/379 (0xF9E/0xFB3), reached only on the carry path above: the
    // discipline countdown ticks on heart decrements, not on minutes. It is a
    // plain floor-at-0 decrement of 0x213 with no character test — the reload
    // and the scold request are label_380's job, one step further down the
    // pass (tickDisciplineRequest).                                      [ROM]
    if (this.disciplineCountdown > 0) this.disciplineCountdown--;
    // NOTHING resets the neglect counter here. The rule that used to live on
    // this line — "0x20A-C resets on every heart-timer expiry" — was
    // [INFERRED] and is refuted twice over: oldie-strat shows the ROM's counter
    // climbing monotonically to 710 by minute 720 where the model's oscillated
    // between 1 and 3, and label_314 (0xCAC) zeroes 0x20A-C only when both
    // meters read nonzero, in the interrupt, on a path the heart pass never
    // reaches. The oldie strat does not work by starving this counter. #3
  }

  /**
   * label_106 (0x31C) via the 0x05C animation dispatcher. Arms 0x208, which is
   * the real clock on a heart-based care mistake.                        [ROM]
   */
  callForAttention() {
    // label_376/378's no-carry arm is `jp set_0x5C_to_a` with a = 2: the
    // meter-empty animation, which ENDS the pass — 0x208 is armed by the
    // animation dispatcher (0x328), not by the pass, and label_380 is not
    // reached until the pass after it. mainLoopPass() runs the tail anyway
    // because that next pass is half a second later and inside the same
    // minute; settlePoke() is the one caller that cannot, so it reads this. #58
    this.heartQueued = true;
    this.callTimer =
      this.character === CHAR.BABYTCHI ? RULES.CALL_ARM_BABY : RULES.CALL_ARM;
    this.emit("callForAttention", { armedAt: this.callTimer });
  }

  /** The interrupt half: label_319 (0xCA1-0xCBB). */
  tickCare() {
    // label_328 (0xCD9): a counter advances only once armed, and saturates.
    // label_319 calls it twice, for 0x208 (0xCA6) and then 0x209 (0xCA8) —
    // the two calls are what make 0x209 a counter rather than a flag. #29
    if (this.callTimer > 0 && this.callTimer < RULES.CALL_FULL) this.callTimer++;
    if (this.scoldTimer > 0 && this.scoldTimer < RULES.CALL_FULL) this.scoldTimer++;

    // label_314 at 0xCAC: 0x20A-C is zeroed only when BOTH meters read
    // nonzero, and otherwise incremented by label_330 (0xCDF) — a bare
    // three-nibble add with no saturate, so it wraps.                    [ROM]
    if (this.hunger !== 0 && this.happy !== 0) {
      this.neglectTimer = 0;
      return;
    }
    this.neglectTimer = (this.neglectTimer + 1) % RULES.NEGLECT_WRAP;
  }

  /**
   * The main-loop half, label_381 (0xFC6). Runs after the heart pass, so a call
   * armed this minute suppresses the booking — which is exactly how a fast
   * character avoids mistakes it would otherwise earn.                   [ROM]
   */
  serviceAttentionCall() {
    if (this.callTimer !== RULES.CALL_FULL) return;
    this.callTimer = 0;
    // label_381 skips label_388 when 0x05D == 1: a Babytchi's calls expire
    // without ever booking anything.                                     [ROM]
    if (this.character === CHAR.BABYTCHI) return;
    this.addCareMistake("hearts");
  }

  /**
   * label_382 (0xFCD), the same shape one step further on: an unanswered scold
   * request saturates 0x209 at 0xF and books a DISCIPLINE mistake into 0x051,
   * through the same saturating label_389 the care mistakes use. Note what is
   * NOT here — the 0x05D == 1 test label_381 has. A baby's ignored scold would
   * book; babies just never get asked (see tickDisciplineRequest).       [ROM]
   */
  serviceScoldCall() {
    if (this.scoldTimer !== RULES.CALL_FULL) return;
    this.scoldTimer = 0;
    this.disciplineMistakes = Math.min(
      RULES.MISTAKE_CLAMP, this.disciplineMistakes + 1);
    this.emit("disciplineMistake", {
      reason: "ignored", total: this.disciplineMistakes,
    });
  }

  /**
   * label_380 (0xFB7), between the heart pass and the two counter services.
   * When the countdown at 0x213 reads 0 the ROM:
   *
   *   1. reloads 0x213 from the character's 0x243 — measured on tended-week,
   *      where a Marutchi's reads 6 the moment it lands on 0 (minute 192) and
   *      a Babytchi's reloads to 0xF at minutes 31 and 61;
   *   2. adds `0x043 + 1` into the accumulator at 0x214, carry set;
   *   3. asks for a scolding — 0x05C = 3, which arms 0x209 — unless that add
   *      CARRIED, or the pet is a Babytchi.
   *
   * Step 3 is where the model's `[INFERRED]` rng skip used to be, and it is
   * not random at all: the higher the discipline meter, the more often the add
   * overflows and the request is dropped. At 0x043 = 0xF it adds 16 and always
   * carries, which is the published "at 100% discipline the ROM stops asking";
   * at 0xC (75%) it carries 13 times in 16, the published "skips many". [ROM]
   */
  tickDisciplineRequest() {
    if (this.disciplineCountdown !== 0) return;
    this.resetDisciplineCountdown();
    const sum = this.disciplineSkip + this.discipline + 1;
    this.disciplineSkip = sum & 0xf;
    if (sum > 0xf) return;                                  // carry: no request
    if (this.character === CHAR.BABYTCHI) return;
    this.scoldTimer = RULES.SCOLD_ARM;                      // label_107
    this.emit("callForDiscipline");
  }

  /**
   * The death gate — label_367 to label_371 (0xF5B-0xF75), run by the awake
   * main-loop pass between the sleep check and the poop queue. Four ways to
   * die, checked in this order, any one setting 0x05C = 6:
   *
   *   1. 0x049 >= 3                        three sicknesses
   *   2. 0x20C >= 2 && 0x20B >= 0xD        neglect counter >= 0x2D0 (720 min)
   *   3. sick && 0x20F >= 1 && 0x20E >= 6  sick count-up >= 0x160 (352 min)
   *   4. 0x04F >= 5                        adult care mistakes
   *
   * 2 and 3 are NIBBLE tests (see the RULES entries) and both are skipped for
   * a Babytchi — 0xF5E branches it straight to the 0x04F check, so a baby can
   * only die of its third sickness. Verified against the ROM on freerun-baby
   * (sick death fires the minute the count-up reads 352, minute 407) and
   * lights-care-mistake (minute 1177).                                  [ROM]
   */
  checkDeath() {
    if (this.deathPending || this.dying || this.stage === STAGE.DEAD) return;
    const baby = this.character === CHAR.BABYTCHI;
    const nHi = (this.neglectTimer >> 8) & 0xf;
    const nMid = (this.neglectTimer >> 4) & 0xf;
    const sHi = (this.sicknessTimer >> 8) & 0xf;
    const sMid = (this.sicknessTimer >> 4) & 0xf;
    let cause = null;
    if (this.sicknessCount >= RULES.SICKNESS_DEATH_COUNT) cause = "sickness";
    else if (!baby && nHi >= RULES.NEGLECT_DEATH_HI && nMid >= RULES.NEGLECT_DEATH_MID)
      cause = "neglect";
    else if (!baby && this.sick && sHi >= RULES.SICK_DEATH_HI && sMid >= RULES.SICK_DEATH_MID)
      cause = "untreatedSickness";
    else if (this.adultCareMistakes >= RULES.ADULT_CARE_MISTAKE_DEATH)
      cause = "careMistakes";
    if (cause === null) return;
    this.deathPending = true;
    this.deathCause = cause;
    // The pass that fires the gate never reaches label_372, so an evolution
    // whose timer expired this same minute is never queued — death wins.
    this.evolutionPending = false;
  }

  /**
   * label_388 (0xFDF). Not an either/or: 0x042 is booked EVERY time, and 0x04F
   * is booked *as well* when the pet is a final-form adult — 0x050 == 0xF with
   * a zero evolution timer, the same idiom label_360 gates the rate decay on.
   * Both go through label_389, which saturates at 0xF rather than wrapping.
   *
   * Measured twice: lights-left-on books the adult mistake at minute 8044 into
   * 0x042 where the model used to put it in 0x04F (#28), and tended-neglect's
   * 0x042 sits at 0xF from minute 634 to the end of the run where the model's
   * used to roll over to 0 (#36).                                        [ROM]
   *
   * The chart-6 wrinkle from #28 stands: a secret-path Maskutchi carries chart
   * 6, fails the 0x050 == 0xF test, and so can never book into 0x04F at all —
   * and it never gets the chance to, because the same chart test in label_372
   * evolves it into Bill the minute its timer expires rather than leaving the
   * timer parked at 0 (#21). Bill is chart 0xF and books normally.
   */
  addCareMistake(reason) {
    this.careMistakes = Math.min(RULES.MISTAKE_CLAMP, this.careMistakes + 1);
    if (this.growthChart === 0xf && this.evolutionTimer === 0) {
      this.adultCareMistakes = Math.min(
        RULES.MISTAKE_CLAMP, this.adultCareMistakes + 1);
    }
    this.emit("careMistake", {
      reason, total: this.careMistakes, adultTotal: this.adultCareMistakes,
    });
  }

  /**
   * label_375 (0xF85). Falling sick is main-loop work, not part of the
   * interrupt's count-down, and it sits behind both animation queues — so the
   * pass that QUEUES a poop or an evolution cannot also fall sick.
   *
   * But the pass that FINISHES one can, and does. Measured on the ROM with a
   * per-instruction change watcher over poop-pileup's window 1755 (the eighth
   * poop, which zeroes 0x20D-F outright):
   *
   *   +7741.9 ms  0x206/7 reloaded          label_109, the poop animation
   *   +7755.7 ms  0x04D 7 -> 8              label_110
   *   +7760.0 ms  0x20D/E -> 0              label_110's `ld mx,0x0` (0x348)
   *   +7893.3 ms  0x048 7 -> F              label_375 at pc 0x0F8B
   *   +7893.6 ms  0x049 0 -> 1              pc 0x0F8D
   *   +59309.9ms  0x200/0x202/0x206 --      the boundary interrupt, label_326
   *   +59320.0ms  0x20D 0 -> 1              label_330 at pc 0x0CE0
   *
   * That last line is the whole reason this is its own method: the onset lands
   * 51 seconds BEFORE the minute's clock interrupt, so the interrupt finds the
   * pet already sick and takes label_321's count-UP arm rather than label_322's
   * count-down. The ROM reads 0x20D-F = 1 at the next sample, not 0. Running
   * the onset only in the post-interrupt pass — which is where mainLoopPass()
   * calls it from — gets 0, and that one nibble is what put poop-pileup's
   * third-sickness death a minute out of step with the ROM's (#56).      [ROM]
   */
  fallSickIfDue() {
    if (!this.sick && this.sicknessTimer === 0) {
      this.sickByte = RULES.SICKNESS_ONSET_BYTE;
      this.sicknessCount++;
      this.emit("sick", { count: this.sicknessCount });
    }
  }

  /**
   * label_116 (0x379-0x37C), the death animation's RAM writes: six nibbles in
   * three `lbpx` pairs. 0x20D-F is deliberately not in the list — freerun-baby's
   * keeps counting down over the corpse (#12).
   *
   * The 0x049 clear only shows up on a pet that dies of its third sickness with
   * the count still on screen: measured at minute 2896 of poop-pileup, where the
   * ROM's 0x049 goes 3 -> 0 in the same record as 0x048 and 0x04D.       [ROM]
   */
  applyDeathAnimationWrites() {
    this.deathPending = false;
    this.dying = true;
    this.sickByte = 0;
    this.sicknessCount = 0;
    this.asleep = false;
    this.lightsOn = true;
    this.poopCount = 0;
  }

  tickSickness() {
    // 0x20D-F counts up while sick (label_321 -> label_330, the bare wrapping
    // add), down while healthy (label_322 -> label_324); reaching 0 = sick.
    // Death is NOT decided here — the count-up feeds checkDeath().      [ROM]
    if (this.sick) {
      this.sicknessTimer = (this.sicknessTimer + 1) % 0x1000;
      return;
    }
    // label_324 floors at 0. Falling sick when it gets there is NOT done here:
    // it is label_375, in the main loop, behind the evolution and poop queues
    // — see mainLoopPass(). Keeping it out of the interrupt is also what stops
    // a third-sickness death resurrecting the sick flag off the near-zero
    // counter one minute after the death animation cleared it.           [ROM]
    if (this.sicknessTimer > 0) this.sicknessTimer--;
  }

  tickPoop() {
    // label_326 again (0xCD2), on 0x206/7. Dropping the poop is main-loop work
    // and lands a minute later, like the hatch and the evolution: freerun-baby
    // reads 0x206 = 0 with 0x04D still 0 at minute 20, then 0x04D = 1 with
    // 0x206/7 = 0x18 at minute 21 — the reload of 25 minus that minute's
    // decrement.                                                        [ROM]
    //
    // Only the decrement is here. Queueing the drop is main-loop work at
    // label_374 and lives in tick(), because the two halves come apart during
    // sleep: freerun-baby's timer reaches 0 at minute 45, the pet naps through
    // 49 without dropping anything, and the poop lands at minute 51.
    if (this.poopTimer > 0) this.poopTimer--;
  }

  /**
   * label_109/110 (0x329-0x34A), the poop animation's RAM writes. 0x04D
   * saturates at 8, and the drop that reaches 8 zeroes 0x20D-F outright when
   * the pet is not already sick — so the eighth poop makes it ill on the spot
   * rather than shortening a countdown.                                  [ROM]
   */
  dropPoop() {
    this.poopCount = Math.min(this.poopCount + 1, RULES.POOP_MAX);
    if (this.poopCount >= RULES.POOP_MAX && !this.sick) this.sicknessTimer = 0;
    this.poopTimer =
      this.stage === STAGE.BABY
        ? RULES.POOP_INTERVAL_BABY
        : RULES.POOP_INTERVAL_OTHER;
    this.emit("poop", { count: this.poopCount });
  }

  tickEvolution() {
    // Sleep freezes this timer like every other (label_314's asleep arm never
    // reaches the per-minute pass, #7). Sickness does NOT: nothing in the pass
    // tests 0x048 before touching 0x210-2. Measured on freerun-baby, where the
    // timer decrements through 16 consecutive sick minutes and the pet evolves
    // at minute 71 with 0x048 still reading 0xF (#9).                    [ROM]
    if (this.asleep) return;
    if (this.evolutionTimer > 0) this.evolutionTimer--;
    // Reaching 0 is acted on by the main loop (label_372), not here: it either
    // queues the evolution animation or sets 0x04E. See mainLoopPass().
  }

  // -- discipline ----------------------------------------------------------

  resetDisciplineCountdown() {
    // 0x213 <- 0x243, the same copy label_348 makes at a character change.
    this.disciplineCountdown = this.statDisciplineReload;
  }

  // -- player actions ------------------------------------------------------

  /**
   * label_220 (0x710) and the two submenu handlers below it. The guards are
   * asymmetric and the asymmetry is real (#34):
   *
   *   label_220  refuses everything while asleep (0x04A bit 3)
   *   label_223  a MEAL additionally refuses while sick (0x728), while 0x209
   *              is pending (0x72C-E), or when 0x040 already reads 0xF
   *              (0x730-2) — each one branches to label_228, the refusal
   *              animation, without touching a meter or the weight
   *   label_224  a SNACK refuses NOTHING. 0x739-0x73B is `ld x,0x41` straight
   *              into `call label_331`: no sickness test, no 0x209 test and no
   *              full-meter test on the way in. label_331 (0xCE5) adds 4 and
   *              clamps at 0xF, so a snack fed to a pet whose happy meter
   *              already reads 0xF adds nothing to the meter and +2 to the
   *              weight anyway. Confirmed on the ROM: snack-attack feeds one
   *              to a sick Babytchi at minute 56 and three at a full 0x041 at
   *              80/81/82, and TamaLIB accepts all four (#45).
   *
   * label_224 does read 0x048 once, at 0x73C, but not to refuse: a healthy
   * pet's snack falls through to label_324 and knocks a minute off the
   * sickness countdown at 0x20D-F (RULES.SNACK_SICKNESS_STEP), and a sick
   * one's jumps over it to the weight add. That is the whole of "too many
   * snacks make it sick".
   *
   * So a snack is the one thing a sick pet will accept, which is what makes
   * "feed snacks while ill" a real strategy rather than a folk belief — and
   * the missing meter test is what makes deliberately fattening a pet on
   * snacks possible at all.                                             [ROM]
   */
  feed(kind = "meal") {
    if (!this.alive || this.asleep) return false;
    if (!this.spec) return false;   // model integrity, see the `spec` getter #55
    // label_331 (0xCE5) adds 4 and clamps at 0xF on both paths; label_214
    // (0x6E5), which every weight change returns through, then clamps 0x046/7
    // into the character's [0x23C/D, 0x23E/F] window.                   [ROM]
    if (kind === "meal") {
      if (this.sick || this.scoldTimer !== 0) return false;
      if (this.hunger >= RULES.HEART_FULL) return false;
      this.hunger = Math.min(RULES.HEART_FULL, this.hunger + RULES.HEART_STEP);
      this.weight = Math.min(this.weight + RULES.MEAL_WEIGHT, this.statMaxWeight);
    } else {
      this.happy = Math.min(RULES.HEART_FULL, this.happy + RULES.HEART_STEP);
      // 0x73C-0x745: a healthy pet's snack runs label_324 on 0x20D-F, the same
      // borrow-chain decrement the clock interrupt uses, floored at 0. A sick
      // pet's jumps straight to label_225.                                [ROM]
      if (!this.sick)
        this.sicknessTimer =
          Math.max(0, this.sicknessTimer - RULES.SNACK_SICKNESS_STEP);
      this.weight = Math.min(this.weight + RULES.SNACK_WEIGHT, this.statMaxWeight);
    }
    this.clearAttentionCall();
    this.emit("feed", { kind, hunger: this.hunger, weight: this.weight });
    return true;
  }

  /**
   * label_332 (0xCE8), the tail of the +4 routine both feeding and the game run
   * through: 0x208 is cleared only once BOTH meters read nonzero. The neglect
   * counter is not touched — the interrupt zeroes that on its own next minute,
   * by the same both-meters test.                                        [ROM]
   */
  clearAttentionCall() {
    if (this.hunger !== 0 && this.happy !== 0) this.callTimer = 0;
  }

  /**
   * The guessing game — one whole five-round session, because that is the unit
   * the ROM's RAM writes happen in.
   *
   * label_196 (0x624) refuses entry while asleep, while sick, or while 0x209
   * is pending (#34). Entry then writes 0x082 = 5 and each round resolves its
   * own carry test in label_282 against the character's 0x245; the player's
   * guess only picks which way the pet turns. Wins accumulate in 0x083, and at
   * the score screen (0x6AD) `cp mx,0x3` decides the reward: three of five or
   * better runs the same +4 / clamp-0xF routine the snack uses. The weight
   * drop at label_206 happens either way.                                [ROM]
   *
   * `wins` OVERRIDES the model's own guesses at the carry tests. 0x05A runs
   * off the programmable timer at a rate no minute-quantised model can track
   * (#15/#16), so the model cannot predict a game — but the oracle logs every
   * score, and run-model.mjs --games feeds it back in here (#13). Without a
   * log the fallback below is the honest shape of the computation and the
   * wrong answer; treat any diff of a `playWhenSad` scenario run without
   * --games as meaningless from the first game onward.               [INFERRED]
   */
  playGame(guess, wins = null) {
    if (!this.alive || this.asleep) return null;
    if (this.sick || this.scoldTimer !== 0) return null;
    if (!this.spec) return null;    // model integrity, see the `spec` getter #55
    void guess;
    if (wins === null) {
      // label_282 (0x900) is `set f,0x1; adc mx,a` on 0x05A with a = 0x245, so
      // the round both CONSUMES and ADVANCES the counter, and the round is a
      // WIN on carry: label_198's `jp c,label_199` is what keeps 0x084 = 8 and
      // the 0x246 win delay, and 0x690 counts a win when 0x084 is nonzero. The
      // model used to have that sense backwards, which made a gameWinByte of
      // 0x8 a 44% round instead of a 56% one (#19).                      [ROM]
      //
      // What is still [INFERRED] is only the starting value: between rounds
      // the programmable timer advances 0x05A ~4.6 times a second on top of
      // this, and that is the part no minute-quantised model can know.
      wins = 0;
      let r = this.rng;
      for (let i = 0; i < RULES.GAME_ROUNDS; i++) {
        const sum = r + this.statGameWinByte + 1;
        r = sum & 0xf;
        if (sum > 0xf) wins++;
      }
      this.rng = r;
    }
    const won = wins >= RULES.GAME_WINS_TO_HAPPY;
    if (won) {
      this.happy = Math.min(RULES.HEART_FULL, this.happy + RULES.HEART_STEP);
    }
    this.weight = Math.max(this.weight - RULES.GAME_WEIGHT_LOSS, this.statMinWeight);
    this.clearAttentionCall();
    this.emit("game", { wins, won, happy: this.happy });
    // The ROM picks the countdown reload per ROUND, from that round's carry
    // (label_198 loads 0x246 or 0x247 into 0x080). This returns one delay for
    // the whole session, which is a UI convenience, not the ROM's shape.
    return {
      wins, won,
      inputDelay: won ? this.statGameDelayWin : this.statGameDelayLose,
    };
  }

  /**
   * One medicine press. label_191/192 (0x600-0x61B): the injection animation
   * clears bit 3 of 0x048 and then ORs it back — a no-op here since it is
   * only ever pressed while already sick — before `add mx,my` adds the
   * character's dose (0x23B). The stored result is the low nibble of that
   * sum; a carry past bit 3 (result < 8) is the cure, and whatever is left in
   * the low 3 bits is a residue that persists until the next onset. #32
   */
  medicine() {
    if (this.asleep) return false;                  // label_191's guard   [ROM]
    if (!this.sick) return false;                   // refuse animation    [ROM]
    if (!this.spec) return false;   // model integrity, see the `spec` getter #55
    const armed = (this.sickByte & 0x7) | 0x8;
    this.sickByte = (armed + this.statMedicineDose) & 0xf;
    if (!this.sick) {
      // Cured: the reload the model already had for the cure path.   [ROM]
      this.sicknessTimer = this.statSicknessTime;
      if (RULES.SICKNESS_COUNT_RESETS_ON_CURE) this.sicknessCount = 0;
      this.emit("cured");
    }
    return true;
  }

  /** label_336 (0xD7E): refused while asleep — the sweep plays either way,
   *  but 0x04D is only zeroed when the pet is awake.                    [ROM] */
  clean() {
    if (this.asleep) return false;
    if (this.poopCount === 0) return false;
    this.poopCount = 0;
    this.emit("clean");
    return true;
  }

  /**
   * label_301 (0xADA). Asleep, nothing happens. Awake with 0x209 pending: the
   * counter is cleared with a plain `ld mx,0x0` and 0x043 gets `add mx,0x4`
   * clamped at 0xF — a quarter of the meter, not one unit. Awake with nothing
   * pending: label_303, animation and buzzer only, no RAM write at all.
   *
   * That last arm refutes the model's old `[INFERRED]` rule that scolding an
   * unasked pet books a discipline mistake. It does not; the only writer of
   * 0x051 is label_382, the ignored-request path (serviceScoldCall). The +4
   * is measured at tended-week minute 193, where 0x043 goes 0 -> 4. #19  [ROM]
   */
  scold() {
    if (!this.alive || this.asleep) return false;
    if (this.scoldTimer === 0) {
      this.emit("scoldIgnored");
      return false;
    }
    this.scoldTimer = 0;
    this.discipline = Math.min(
      RULES.DISCIPLINE_FULL, this.discipline + RULES.DISCIPLINE_STEP);
    this.emit("scold", { discipline: this.discipline });
    return true;
  }

  /**
   * label_298 (0xACF). Turning the lights OFF writes 0xF to 0x205 — it disarms
   * the lights care mistake rather than clearing the counter, which is the only
   * reason the counter's low nibble survives. Turning them back ON writes
   * nothing, so it does not re-arm: once disarmed, only the next bedtime
   * re-arms, because that is what reloads 0x204/5 (label_102). Leaving the
   * lights off from before bedtime therefore does NOT help.              [ROM]
   */
  setLights(on) {
    this.lightsOn = on;
    if (!on) {
      this.lightsTimer =
        (this.lightsTimer & 0x0f) | (RULES.LIGHTS_DISARMED_HI << 4);
    }
    this.emit("lights", { on });
  }

  // -- differential testing ------------------------------------------------

  /**
   * Emit state keyed by the RAM address it mirrors, for nibble-level diffing
   * against a TamaLIB memory dump. Values are returned as integers; split
   * multi-nibble fields yourself when comparing (the P1 stores decimal values
   * like age and weight as BCD across two nibbles).
   *
   * Booleans are emitted as plain 1/0. The nibble the ROM actually writes for
   * a set flag lives in harness/fields.mjs and nowhere else — this used to be
   * duplicated here, and both copies said 0x8 for 0x048 where the ROM says
   * 0xF, so the two agreed with each other and neither agreed with the ROM.
   *
   * 0x048 is the one exception to "booleans as 1/0": it is not a flag at all,
   * so it is emitted as the raw nibble (sickByte) — see the `sick` getter
   * and RULES.SICKNESS_ONSET_BYTE.                                    [ROM]
   *
   * The address -> property list itself is RAM_MAP, above the class, because
   * pokeRam() has to walk the same list in the other direction.
   */
  dumpRam() {
    const out = {};
    for (const f of RAM_MAP) {
      const v = this[f.prop];
      out[f.addr] = f.kind === "bool" ? (v ? 1 : 0) : (v ?? 0);
    }
    return out;
  }

  /**
   * The inverse of dumpRam(): write one field through the RAM_MAP entry
   * dumpRam() reads it from, so a poke is guaranteed to land on the property
   * the panel is showing. This is the model's debug surface for #25 — the RAM
   * panel in index.html is writable through it.
   *
   * A poke is a memory poke and nothing more: it writes the raw field and runs
   * no side effects. Poking 0x05D leaves the previous character's stat vector
   * loaded in 0x230-0x249, because the ROM only reloads that vector at an
   * evolution (label_347) and a poke is not an evolution; poking 0x048 re-gates
   * nothing beyond whatever reads `sick` on the next tick. Since #54 the vector
   * is in RAM_MAP too, so a scenario that DOES want the new character's rates
   * pokes 0x230-0x249 as well — no handler runs on either side, and both sides
   * start from the same block.
   *
   * The ONE thing a poke updates besides the field is `stage`, and only for
   * 0x05D. `stage` is not RAM and the ROM has no such variable: it is the
   * model's cache of what CHARACTERS says about 0x05D, and leaving it stale
   * would put the model in a state the RAM does not describe — a live adult's
   * character nibble with an egg's behaviour. Re-deriving it is restoring that
   * invariant, not running label_347 (which is what loadStatBlock() is, and
   * which a poke still does not do).
   *
   * Validation is the field's own nibble width (`max`) and nothing else, with
   * ONE exception: a debugger must be able to write an illegal *state* — that
   * is the point — but not a value the nibbles could not physically hold, and
   * not one the model could not then execute (POKE_TABLE_INDEXED, #55). The
   * model's clamps are still unconfirmed anyway (#18), so they are not the
   * authority here.
   *
   * @param  {number} addr  base RAM address, as keyed in dumpRam()
   * @param  {number} value decoded value, clamped to 0..max
   * @return {number|null}  the value written, or null if nothing was written
   */
  pokeRam(addr, value) {
    const f = RAM_MAP.find((e) => e.addr === addr);
    const n = Number(value);
    if (!f || !Number.isFinite(n)) return null;
    const v = Math.min(f.max, Math.max(0, Math.trunc(n)));
    // The one refusal, and it is model integrity rather than a ROM rule: see
    // POKE_TABLE_INDEXED above the class.
    const executable = POKE_TABLE_INDEXED[f.addr];
    if (executable && !executable(v, this)) return null;
    this[f.prop] = f.kind === "bool" ? v !== 0 : v;
    // 0x05D's derived cache — see the note above. POKE_TABLE_INDEXED has
    // already refused any value with no CHARACTERS entry, so this cannot
    // produce a stage the model has no rules for.
    if (f.addr === 0x05d) this.stage = CHARACTERS[v].stage;
    this.emit("poke", {
      addr: "0x" + f.addr.toString(16).padStart(3, "0"),
      field: f.prop,
      value: v,
    });
    return v;
  }

  /** Run n minutes, optionally applying scripted actions at given tick counts. */
  run(minutes, script = {}) {
    for (let i = 0; i < minutes; i++) {
      const action = script[this.elapsed];
      if (action) action(this);
      this.tick();
      if (this.stage === STAGE.DEAD) break;
    }
    return this;
  }
}

// ---------------------------------------------------------------------------
// Self-check: the derived rate curve must reproduce the published ROM vectors.
// ---------------------------------------------------------------------------

export const PUBLISHED_VECTORS = {
  mametchiHungry: [81, 61, 46, 35, 27, 21, 16, 12, 9, 7, 6, 5],
  mametchiHappy: [91, 69, 52, 39, 30, 23, 18, 14, 11, 9, 7, 6],
  maskutchiHungry: [55, 42, 32, 24, 18, 14, 11, 9, 7, 6, 5, 4],
  maskutchiHappy: [65, 49, 37, 28, 21, 16, 12, 9, 7, 6, 5, 4],
  kuchipatchiHungry: [60, 45, 34, 26, 20, 15, 12, 9, 7, 6, 5, 4],
  kuchipatchiHappy: [70, 53, 40, 30, 23, 18, 14, 11, 9, 7, 6, 5],
  tarakotchiHungry: [45, 34, 26, 20, 15, 12, 9, 7, 6, 5, 4, 3],
  tarakotchiHappy: [50, 38, 29, 22, 17, 13, 10, 8, 6, 5, 4, 3],
};

export function verifyRateCurve() {
  const fails = [];
  for (const [name, expected] of Object.entries(PUBLISHED_VECTORS)) {
    const got = rateCurve(expected[0]);
    if (got.join(",") !== expected.join(",")) fails.push({ name, got, expected });
  }
  return { pass: fails.length === 0, fails };
}
