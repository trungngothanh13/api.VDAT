export interface ParsedBinaryFrame {
  header: Record<string, any>;
  payload: Buffer;
}

/**
 * Decodes a binary WebSocket video packet framed as:
 *   [4-byte uint32 big-endian headerLen][UTF-8 JSON header][raw JPEG bytes]
 */
export function parseBinaryFrame(buf: Buffer): ParsedBinaryFrame | null {
  if (buf.length < 4) return null;
  const headerLen = buf.readUInt32BE(0);
  if (headerLen <= 0 || 4 + headerLen > buf.length) return null;
  try {
    const header = JSON.parse(buf.subarray(4, 4 + headerLen).toString('utf8')) as Record<string, any>;
    const payload = buf.subarray(4 + headerLen);
    return { header, payload };
  } catch {
    return null;
  }
}

/**
 * Encodes a binary WebSocket video packet framed as:
 *   [4-byte uint32 big-endian headerLen][UTF-8 JSON header][raw JPEG bytes]
 */
export function encodeBinaryFrame(header: Record<string, any>, payload: Buffer): Buffer {
  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(headerBuf.length, 0);
  return Buffer.concat([lenBuf, headerBuf, payload]);
}
