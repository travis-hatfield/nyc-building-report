// Normalize a street address so "East 28th Street" and "E 28 St" compare equal.
const WORDS = {
  east: 'e', west: 'w', north: 'n', south: 's', street: 'st', avenue: 'ave', road: 'rd', boulevard: 'blvd',
  place: 'pl', drive: 'dr', court: 'ct', lane: 'ln', parkway: 'pkwy', square: 'sq', terrace: 'ter',
};
function normAddress(a) {
  return String(a || '').toLowerCase()
    .replace(/\b(apt|apartment|unit|#)\s*\S+$/i, '')
    .replace(/(\d+)(st|nd|rd|th)\b/g, '$1')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/).filter(Boolean).map((w) => WORDS[w] || w).join(' ');
}
module.exports = { normAddress };
