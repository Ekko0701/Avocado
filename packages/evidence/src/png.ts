const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG 머리(IHDR)에서 가로·세로를 읽는다. PNG 가 아니면 null */
export function pngSize(head: Buffer): { width: number; height: number } | null {
  if (head.length < 24 || !head.subarray(0, 8).equals(SIGNATURE) || head.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = head.readUInt32BE(16);
  const height = head.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}
