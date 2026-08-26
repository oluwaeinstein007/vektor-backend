// ML-006 (REQ-2.6): "Upload -> validate -> hot-load in onnxruntime-node
// within 5 minutes, no service restart." §13.1's `/api/v1/models/upload`
// (SuperAdmin-only per the REQ table) lives here.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyPluginAsync } from "fastify";
import fastifyMultipart from "@fastify/multipart";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { DetectionModel } from "../inference/session.js";

const UploadResponse = z.object({ status: z.literal("ok"), executionProvider: z.enum(["cuda", "cpu"]) });
const ErrorResponse = z.object({ error: z.string() });

export interface ModelsRoutesOptions {
  getModel: () => DetectionModel;
  requireGpu: boolean;
}

const modelsRoutes: FastifyPluginAsync<ModelsRoutesOptions> = async (app, options) => {
  await app.register(fastifyMultipart, {
    limits: { fileSize: 500 * 1024 * 1024 }, // 500MB — generous for an INT8 edge model, well under a full-precision one
  });

  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post(
    "/api/v1/models/upload",
    { preHandler: app.requireRole("superadmin"), schema: { response: { 200: UploadResponse, 400: ErrorResponse } } },
    async (request, reply) => {
      const file = await request.file();
      if (!file) {
        return reply.code(400).send({ error: "no file field in multipart body" });
      }
      if (!file.filename.endsWith(".onnx")) {
        return reply.code(400).send({ error: "expected an .onnx file" });
      }

      const buffer = await file.toBuffer();
      const stagingDir = await mkdtemp(join(tmpdir(), "cv-inference-model-"));
      const stagedPath = join(stagingDir, file.filename);
      await writeFile(stagedPath, buffer);

      // Loading a fresh session against the staged file IS the validation
      // step (REQ-2.6's "validate") — an ONNX file that doesn't parse or
      // declares a shape onnxruntime can't run throws here, before it ever
      // touches the live model.
      try {
        await DetectionModel.load(stagedPath, { requireGpu: options.requireGpu });
      } catch (err) {
        return reply.code(400).send({
          error: `model failed to load: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      const model = options.getModel();
      await model.swap(stagedPath);

      return { status: "ok" as const, executionProvider: model.executionProvider };
    },
  );
};

export default modelsRoutes;
