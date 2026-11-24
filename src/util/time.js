// Dates are UTC: YYYY-MM-DD in files, full ISO timestamps in markers.
export const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
export const isoTime = (ms) => new Date(ms).toISOString();
export const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
