// Small display-formatting helpers for the Roman-themed visual design -
// no game logic here, just how numbers get shown.

const ROMAN_VALUES = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
  [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
  [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

export function toRoman(num) {
  let n = num;
  let result = '';
  for (const [value, symbol] of ROMAN_VALUES) {
    while (n >= value) {
      result += symbol;
      n -= value;
    }
  }
  return result || String(num);
}

// Spelled-out ordinals, for prose that reads as a sentence rather than a
// spec - "Add a fourth video" beats "Add a 4th video" on a button. Only
// needs to cover the clip-slot range (see MAX_CLIP_SLOTS); anything past
// it falls back to the numeric form below.
const ORDINAL_WORDS = [
  null, 'first', 'second', 'third', 'fourth', 'fifth',
  'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
];

export function ordinalWord(n) {
  return ORDINAL_WORDS[n] || ordinal(n);
}

export function ordinal(n) {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]);
}

// A submission's source, shown as a badge/label wherever an entry is listed
// (presenter feed, ballot, reveal podium).
export function platformLabel(platform) {
  if (platform === 'tiktok') return 'TikTok';
  if (platform === 'upload') return 'Uploaded video';
  return 'Instagram Reels';
}
