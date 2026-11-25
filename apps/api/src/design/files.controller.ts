import { Controller, ForbiddenException, Get, Inject, NotFoundException, Optional, Param, Query, Res, ServiceUnavailableException } from "@nestjs/common";
import type { Pool } from "pg";
import { DATABASE } from "../database";
import { Public } from "../public.decorator";
import type { DesignConfig } from "./config";
import { DESIGN_CONFIG } from "./jobs.controller";
import { ArtifactStore } from "./store";
import { verifyFileSignature } from "./signing";

const TYPES: Record<string, string> = {
  STEP: "model/step", STL: "model/stl", GLB_PREVIEW: "model/gltf-binary", DFM_REPORT: "application/json", MANIFEST: "application/json",
};
interface FileResponse {
  setHeader(name: string, value: string): void;
  status(code: number): FileResponse;
  end(): void;
}

/** downloadFile: the signature from getJobArtifact is the authorization (5 min, bound to the hash). */
@Controller("files")
export class FilesController {
  private store: ArtifactStore | null;

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Optional() @Inject(DESIGN_CONFIG) private readonly design: DesignConfig | null,
  ) {
    this.store = design ? new ArtifactStore(design.artifactDir) : null;
  }

  @Get(":sha256")
  @Public()
  async download(@Param("sha256") sha: string, @Query("exp") exp: string, @Query("sig") sig: string, @Res() res: FileResponse) {
    if (!this.design || !this.store) throw new ServiceUnavailableException();
    if (!/^[0-9a-f]{64}$/.test(sha) || !verifyFileSignature(this.design.fileUrlSecret, sha, Number(exp), String(sig ?? ""))) {
      throw new ForbiddenException();
    }
    const { rows } = await this.pool.query<{ kind: string; name: string }>("SELECT kind, name FROM aurea.job_artifact WHERE sha256 = $1 LIMIT 1", [sha]);
    const file = rows[0] ? this.store.open(sha) : null;
    if (!file) throw new NotFoundException();
    res.setHeader("content-type", TYPES[rows[0].kind] ?? "application/octet-stream");
    res.setHeader("content-length", String(file.bytes));
    res.setHeader("content-disposition", `attachment; filename="${rows[0].name}"`);
    res.setHeader("etag", `"${sha}"`);
    res.setHeader("cache-control", "private, max-age=300, immutable");
    res.setHeader("x-content-type-options", "nosniff");
    file.stream.pipe(res as unknown as NodeJS.WritableStream);
  }
}
