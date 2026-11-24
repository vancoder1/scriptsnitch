// Script URL identity (design §8). Task 8 replaces this first version of isBuildToken with the
// full heuristic and adds URL kinds and slots.

// A content-derived token in a file name: 8+ hex characters, or 8+ base64url characters that mix
// character classes (letters with digits, or upper with lower case).
export function isBuildToken(segment) {
  if (typeof segment !== 'string' || segment.length < 8 || !/^[A-Za-z0-9_-]+$/.test(segment)) return false;
  if (/^[0-9a-f]+$/.test(segment) && /[0-9]/.test(segment)) return true;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(segment)).length;
  return classes >= 2;
}
