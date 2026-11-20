/** Hex helpers. `fromHex` accepts spaces, colons and dashes as separators. */

export function toHex(bytes: Uint8Array, sep = ' '): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(sep);
}

export function fromHex(text: string): Uint8Array {
  const clean = text.replace(/[\s:,-]/g, '').replace(/^0x/i, '');
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) {
    throw new SyntaxError(`invalid hex: "${text}"`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(2 * i, 2 * i + 2), 16);
  return out;
}
