import { byteLength, FRAME_LIMIT } from './protocol';

export class ObservationBound extends Error {}

// Decode before splitting lines so UTF-8 sequences, CRLF pairs and JSON
// frames can all span byte chunks. Frame length is measured before parsing.
export function createSseReader(onFrame: (data: string) => void, maxFrameBytes = FRAME_LIMIT) {
  const decoder = new TextDecoder();
  let line = '';
  let fields: string[] = [];
  let frameBytes = 0;
  let previousCr = false;

  function emitLine() {
    if (!line) {
      if (fields.length) onFrame(fields.join('\n'));
      frameBytes = 0;
      fields = [];
      return;
    }
    if (line.startsWith('data:')) fields.push(line.slice(5).replace(/^ /, ''));
    frameBytes += byteLength(line) + 1;
    if (frameBytes > maxFrameBytes) throw new ObservationBound();
    line = '';
  }

  function parse(text: string) {
    let start = 0;
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (previousCr) {
        previousCr = false;
        if (character === '\n') {
          start = index + 1;
          continue;
        }
      }
      if (character !== '\n' && character !== '\r') continue;
      line += text.slice(start, index);
      emitLine();
      previousCr = character === '\r';
      start = index + 1;
    }
    line += text.slice(start);
    // UTF-16 code units are a lower bound on UTF-8 bytes. Verify the
    // exact byte count for complete lines and bound the pending fragment.
    if (frameBytes + line.length > maxFrameBytes) throw new ObservationBound();
  }

  return {
    push(chunk: Uint8Array) { parse(decoder.decode(chunk, { stream: true })); },
    finish() {
      parse(decoder.decode());
      if (line) emitLine();
      if (fields.length) emitLine();
    },
  };
}
