import express from 'express';
import { requireAccount, requireSameOrigin } from '../../../server/api/auth.js';
import { createUploadRequestService } from '../../../server/uploads/admission.js';
import { importPack, PACK_LIMITS } from './pack-import.js';

export function createPackUploads({ catalog }) {
  const uploads = createUploadRequestService({ maxConcurrent: 2 });
  return {
    mount(app, { apiLimiter = (_request, _response, next) => next() } = {}) {
      const api = express.Router();
      api.use(apiLimiter, (_request, response, next) => {
        response.set('Cache-Control', 'no-store');
        next();
      });
      api.get('/', (_request, response) =>
        response.json({
          characters: catalog.characters(),
          stages: catalog.stages(),
          maxUploadBytes: PACK_LIMITS.upload,
        }),
      );
      api.post(
        '/:kind',
        requireSameOrigin,
        requireAccount,
        uploads.handle(
          express.raw({ type: 'application/octet-stream', limit: PACK_LIMITS.upload }),
          async (request, response) => {
            const pack = await importPack({
              catalog,
              kind: request.params.kind,
              filename: request.query.name,
              buffer: request.body,
              signal: request.uploadSignal,
            });
            response.status(201).json({ pack });
          },
        ),
      );
      app.use('/api/mugen/packs', api);
    },
    stop: uploads.stop,
    status: uploads.status,
  };
}
