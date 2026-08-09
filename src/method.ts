// The coaching method: what the coach listens for and how corrections are
// taught. Distilled in our own words from the published teaching of Vinh
// Giang (the vocal-instruments school of delivery coaching) and the broader
// vocal canon. Method, not persona: the coach never claims to be, quote, or
// speak for any real coach — this file is standards, vocabulary, and craft.
//
// Both ears and mouth consume it: the analyzer hears with this vocabulary,
// the persona teaches with it. One source, so a diagnosis named by the ears
// is a word the coach already owns.

/** One playable dimension of the voice. */
export interface Instrument {
  name: string;
  /** What the ears attend to, audio-first. */
  listenFor: string;
  /** What good sounds like — the standard, not a platitude. */
  good: string;
}

/** A named failure pattern with an audible signature and a listener cost. */
export interface Trap {
  name: string;
  sound: string;
  cost: string;
}

export const instruments: Instrument[] = [
  {
    name: 'Rate',
    listenFor:
      'overall speed, and — more telling — whether speed ever varies; whether key sentences get slowed down or arrive at the same clip as everything else; pace climbing under pressure',
    good: 'contrast: quicker through connective tissue, deliberately slower on the line that matters — a slowed key sentence reads as authority',
  },
  {
    name: 'Volume',
    listenFor:
      'dynamics across the take; whether ends of sentences hold their level or collapse as breath runs out; whether anything is ever delivered quieter on purpose',
    good: 'a small deliberate drop pulls the room in on the crucial line; steady support to the last word of the sentence',
  },
  {
    name: 'Pitch',
    listenFor:
      'where sentences end: landing down, or rising so a statement leaves as a question; where the voice sits when the speaker is sure versus hedging',
    good: 'declaratives land down — the claim arrives decided, not submitted for approval',
  },
  {
    name: 'Melody',
    listenFor:
      'pitch movement across the phrase; whether delivery flattens into monotone when the material turns formal or high-stakes',
    good: 'natural variation that matches meaning — melody is where conviction is audible; flat delivery of strong material wastes it',
  },
  {
    name: 'Pause',
    listenFor:
      'silence before and after key lines, or its absence; fillers (um, uh, so, like) standing where pauses should be; whether the speaker ever lets a point breathe',
    good: 'a held pause before or after the line that matters — silence spends as confidence, and gives the room time to think',
  },
];

export const traps: Trap[] = [
  {
    name: 'The rush',
    sound: 'pace climbs, pauses vanish, sentences chain without air',
    cost: 'reads as asking permission to leave — urgency where weight was needed',
  },
  {
    name: 'Uptalk',
    sound: 'declarative sentences end on a rise',
    cost: 'every claim arrives pre-doubted; the room hears a question where a decision was meant',
  },
  {
    name: 'The fade',
    sound: 'ends of sentences lose volume and articulation as breath runs out',
    cost: 'the most important words — usually the ask — get the least air',
  },
  {
    name: 'Filler flood',
    sound: 'um, uh, so, like carrying every transition',
    cost: 'each one spends a little credibility; the silence it covers would have read as composure',
  },
  {
    name: 'Monotone armor',
    sound: 'pitch variation flattens when the material turns formal',
    cost: 'the speaker sounds guarded or detached from their own point',
  },
  {
    name: 'Self-discounting',
    sound: 'hedges ahead of the point — "this might be obvious", "just", "sort of", "I guess"',
    cost: 'the speaker convicts their own idea before the room can weigh it',
  },
];

/**
 * How corrections are taught, whoever delivers them. The app's one-priority
 * rule is this pedagogy: one instrument at a time, contrast as the teacher,
 * a rep within the minute, listening back as the mirror.
 */
export const correctionCraft: string[] = [
  'One instrument at a time. A take gets one correction, held until it moves; stacked corrections teach nothing.',
  'Contrast is the teacher: perform the line both ways — as delivered, then played (slower, a held pause, the ending landed down) — so the difference is heard, not described.',
  'Then one rep, immediately, under a minute. The drill is the line they just heard, in their own mouth.',
  'Listening back is the mirror: the gap between how a take felt and how it sounds is the coaching surface. Rolling tape of ten honest seconds beats a paragraph about them.',
  'Fillers are replaced, not suppressed: the correction is the pause underneath, never "stop saying um".',
];

/** The listening brief's method block: vocabulary the ears diagnose with. */
export function methodBriefLines(): string[] {
  return [
    'Listen through the five instruments of delivery, alongside structure and clarity of the ask:',
    ...instruments.map((i) => `- ${i.name}: ${i.listenFor}. Good sounds like: ${i.good}.`),
    '',
    'Named traps — when one fits what you heard, diagnose it by name and evidence, never by vibe:',
    ...traps.map((t) => `- ${t.name}: ${t.sound} — the cost: ${t.cost}.`),
  ];
}

/** The persona's method block: how the coach speaks about and teaches delivery. */
export function personaMethodLines(): string[] {
  return [
    'Your school of coaching treats the voice as five instruments — rate, volume, pitch, melody, pause — and delivery problems as named traps: the rush, uptalk, the fade, filler flood, monotone armor, self-discounting. This is your vocabulary for everything delivery: interpreting the specialist\'s note, asking sharper questions, demonstrating.',
    ...correctionCraft,
    'The method never overrides the evidence rule: claims about how a take sounded still come only from the specialist\'s analysis note. The method is how you teach what the note found — and when you demonstrate a sharper delivery, play the instruments out loud: slow the key line, drop quieter, hold the pause, land the ending down.',
  ];
}
