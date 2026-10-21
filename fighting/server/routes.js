import express from 'express';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readdirSync, statSync, readFileSync } from 'node:fs';

export function mountMugenRoutes(
  app,
  {
    apiLimiter = (_request, _response, next) => next(),
    dataRoot = fileURLToPath(new URL('../data/', import.meta.url)),
  } = {},
) {
  // MUGEN assets — characters in Characters/ subfolder, stages in Stages/.
  const MUGEN_CHARS_DIR = resolve(dataRoot, 'Characters');
  const MUGEN_STAGES_DIR = resolve(dataRoot, 'Stages');
  const _mugenStaticOpts = {
    cacheControl: true,
    maxAge: '1d',
    acceptRanges: true,
    setHeaders(res, filePath) {
      if (/\.(def|air|cns|cmd)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    },
  };
  // /mugen-stages/ must be registered before /mugen/ to avoid prefix overlap
  app.use(
    '/mugen-stages',
    express.static(MUGEN_STAGES_DIR, { ..._mugenStaticOpts, fallthrough: false }),
  );
  app.use('/mugen', express.static(MUGEN_CHARS_DIR, { ..._mugenStaticOpts, fallthrough: false }));

  // List available MUGEN characters — reads sub-folders in MUGEN_CHARS_DIR.
  app.get('/api/mugen/chars', apiLimiter, (req, res) => {
    try {
      const chars = [];
      const entries = readdirSync(MUGEN_CHARS_DIR);
      for (const entry of entries) {
        try {
          if (!statSync(resolve(MUGEN_CHARS_DIR, entry)).isDirectory()) continue;
          // Look for .def directly in the folder, or one level deeper (common when
          // the downloaded archive adds an extra wrapper subfolder).
          let defFile = null,
            subFolder = '';
          const topFiles = readdirSync(resolve(MUGEN_CHARS_DIR, entry));
          defFile = topFiles.find((f) => f.toLowerCase().endsWith('.def'));
          if (!defFile) {
            for (const sub of topFiles) {
              try {
                if (!statSync(resolve(MUGEN_CHARS_DIR, entry, sub)).isDirectory()) continue;
                const subFiles = readdirSync(resolve(MUGEN_CHARS_DIR, entry, sub));
                const found = subFiles.find((f) => f.toLowerCase().endsWith('.def'));
                if (found) {
                  defFile = found;
                  subFolder = sub + '/';
                  break;
                }
              } catch {
                /* skip */
              }
            }
          }
          if (!defFile) continue;
          const defText = readFileSync(
            resolve(MUGEN_CHARS_DIR, entry, subFolder, defFile),
            'latin1',
          );
          const nameMatch =
            defText.match(/^\s*displayname\s*=\s*"?([^"\r\n]+)"?/im) ||
            defText.match(/^\s*name\s*=\s*"?([^"\r\n]+)"?/im);
          chars.push({
            folder: entry + (subFolder ? '/' + subFolder.slice(0, -1) : ''),
            defFile,
            name: nameMatch ? nameMatch[1].trim() : entry,
          });
        } catch {
          /* skip unreadable entries */
        }
      }
      res.json(chars);
    } catch {
      res.status(500).json({ error: 'failed to list MUGEN chars' });
    }
  });

  // List available MUGEN stages — reads sub-folders in MUGEN_STAGES_DIR.
  app.get('/api/mugen/stages', apiLimiter, (req, res) => {
    try {
      const stages = [];
      const entries = readdirSync(MUGEN_STAGES_DIR);
      for (const entry of entries) {
        try {
          if (!statSync(resolve(MUGEN_STAGES_DIR, entry)).isDirectory()) continue;
          const files = readdirSync(resolve(MUGEN_STAGES_DIR, entry));
          const defFile = files.find((f) => f.toLowerCase().endsWith('.def'));
          const sffFile = files.find((f) => f.toLowerCase().endsWith('.sff'));
          if (!defFile || !sffFile) continue;
          const defText = readFileSync(resolve(MUGEN_STAGES_DIR, entry, defFile), 'latin1');
          const nameMatch = defText.match(/^\s*name\s*=\s*"?([^"\r\n]+)"?/im);
          stages.push({
            folder: entry,
            defFile,
            sffFile,
            name: nameMatch ? nameMatch[1].trim() : entry,
          });
        } catch {
          /* skip unreadable entries */
        }
      }
      res.json(stages);
    } catch {
      res.status(500).json({ error: 'failed to list MUGEN stages' });
    }
  });
}
