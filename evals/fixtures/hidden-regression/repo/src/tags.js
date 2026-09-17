export function normalise(tags) {
  return tags.map((t) => t.trim().toLowerCase());
}

export function unique(tags) {
  return [...new Set(normalise(tags))];
}
