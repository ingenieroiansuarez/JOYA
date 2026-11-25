import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";

const SHA = /^[0-9a-f]{64}$/;

/**
 * Content-addressed files: the name is the SHA-256 of the bytes, so a file is written once and a
 * stored file can never be swapped for another. Writes are atomic (temporary file + rename).
 */
export class ArtifactStore {
  constructor(private readonly dir: string) {}

  private path(sha256: string): string {
    if (!SHA.test(sha256)) throw new Error("invalid sha256");
    return join(this.dir, sha256.slice(0, 2), sha256);
  }

  put(data: Buffer, expectedSha256: string): void {
    const sha = createHash("sha256").update(data).digest("hex");
    if (sha !== expectedSha256) throw new Error("artifact hash mismatch");
    const target = this.path(sha);
    if (existsSync(target)) return;
    mkdirSync(join(this.dir, sha.slice(0, 2)), { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, target);
  }

  has(sha256: string): boolean {
    return existsSync(this.path(sha256));
  }

  open(sha256: string): { stream: Readable; bytes: number } | null {
    const p = this.path(sha256);
    if (!existsSync(p)) return null;
    return { stream: createReadStream(p), bytes: statSync(p).size };
  }
}
