// Chrome DevTools Protocol over --remote-debugging-pipe: JSON messages separated by a NUL byte,
// written to Chrome's fd 3 and read from its fd 4. Flattened sessions share one connection.

export class CdpError extends Error {
  constructor(method, { code, message }) {
    super(`${method}: ${message}`);
    this.name = 'CdpError';
    this.method = method;
    this.code = code;
  }
}

export class CdpTimeoutError extends Error {
  constructor(method, ms) {
    super(`${method}: no answer from Chrome within ${ms} ms`);
    this.name = 'CdpTimeoutError';
    this.method = method;
  }
}

export class ChromeExitedError extends Error {
  constructor(method) {
    super(method ? `${method}: Chrome exited before answering` : 'Chrome exited');
    this.name = 'ChromeExitedError';
  }
}

export function createConnection({ input, output, timeoutMs = 30000 }) {
  let nextId = 0;
  let closed = false;
  let pending = Buffer.alloc(0);
  const waiting = new Map();
  const handlers = new Map();
  const closeHandlers = [];

  function dispatch(message) {
    if (message.id !== undefined) {
      const entry = waiting.get(message.id);
      if (!entry) return;
      waiting.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new CdpError(entry.method, message.error));
      else entry.resolve(message.result ?? {});
      return;
    }
    const list = handlers.get(message.method);
    if (list) for (const handler of [...list]) handler(message.params ?? {}, message.sessionId);
  }

  function shutdown() {
    if (closed) return;
    closed = true;
    for (const entry of waiting.values()) {
      clearTimeout(entry.timer);
      entry.reject(new ChromeExitedError(entry.method));
    }
    waiting.clear();
    for (const handler of closeHandlers) handler();
  }

  input.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    let end;
    while ((end = pending.indexOf(0)) !== -1) {
      const frame = pending.subarray(0, end).toString('utf8');
      pending = pending.subarray(end + 1);
      if (frame) dispatch(JSON.parse(frame));
    }
  });
  input.on('end', shutdown);
  input.on('close', shutdown);
  input.on('error', shutdown);
  output.on('error', shutdown);

  return {
    send(method, params = {}, sessionId) {
      if (closed) return Promise.reject(new ChromeExitedError(method));
      const id = ++nextId;
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new CdpTimeoutError(method, timeoutMs));
        }, timeoutMs);
        timer.unref?.();
        waiting.set(id, { method, resolve, reject, timer });
        output.write(`${JSON.stringify(message)}\0`);
      });
    },
    on(method, handler) {
      if (!handlers.has(method)) handlers.set(method, new Set());
      handlers.get(method).add(handler);
      return () => handlers.get(method)?.delete(handler);
    },
    onClose(handler) {
      closeHandlers.push(handler);
    },
    close: shutdown,
    get closed() {
      return closed;
    },
  };
}
