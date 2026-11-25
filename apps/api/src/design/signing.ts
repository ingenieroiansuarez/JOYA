import { createHmac, timingSafeEqual } from "node:crypto";

export const FILE_URL_TTL_S = 300;

export function fileSignature(secret: string, sha256: string, exp: number): string {
  return createHmac("sha256", secret).update(`files.${sha256}.${exp}`).digest("hex");
}

export function verifyFileSignature(secret: string, sha256: string, exp: number, sig: string, nowS = Date.now() / 1000): boolean {
  if (!Number.isInteger(exp) || exp < nowS || exp > nowS + FILE_URL_TTL_S + 5) return false;
  if (!/^[0-9a-f]{64}$/.test(sig)) return false;
  return timingSafeEqual(Buffer.from(fileSignature(secret, sha256, exp), "hex"), Buffer.from(sig, "hex"));
}

/** Same scheme as services/geometry/aurea_geometry/worker.py `sign`. */
export function workerSignature(secret: string, method: string, path: string, body: Buffer, t = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`${t}.${method}.${path}.`), body])).digest("hex");
  return `t=${t},v1=${mac}`;
}
