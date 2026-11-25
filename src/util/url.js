// URL helpers shared by the pattern matcher and the account-key rules.

// A path with percent-encoded unreserved characters (letters, digits, - . _ ~) decoded, as a server
// decodes them: /%67tm.js is /gtm.js. Other escapes stay as they are, in upper case.
export function decodeUnreserved(path) {
  return String(path).replace(/%([0-9A-Fa-f]{2})/g, (m, hex) => {
    const c = String.fromCharCode(parseInt(hex, 16));
    return /[A-Za-z0-9\-._~]/.test(c) ? c : m.toUpperCase();
  });
}
