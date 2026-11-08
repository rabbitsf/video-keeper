// Minimal native messaging client: starts a helper the way a browser does and speaks its
// length-prefixed JSON protocol. Used by test/host.test.js and tools/windows/smoke-test.mjs.
import { spawn } from 'node:child_process';

// Sends `messages`, collects replies until `until(reply)` is true, then closes stdin (like a port
// closing) and resolves with all replies once the helper exits.
export function talk(command, args, { env, timeout = 10000, shell = false } = {}, messages, until) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, shell, stdio: ['pipe', 'pipe', 'inherit'] });
    const replies = [];
    let buffer = Buffer.alloc(0);
    let finished = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout; replies: ${JSON.stringify(replies)}`));
    }, timeout);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (finished) resolve(replies);
      else reject(new Error(`helper exited (${code}) early; replies: ${JSON.stringify(replies)}`));
    });
    child.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (!finished && buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const length = buffer.readUInt32LE(0);
        replies.push(JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')));
        buffer = buffer.subarray(4 + length);
        if (until(replies.at(-1))) {
          finished = true;
          child.stdin.end();
        }
      }
    });
    for (const message of messages) {
      const body = Buffer.from(JSON.stringify(message));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      child.stdin.write(Buffer.concat([header, body]));
    }
  });
}
