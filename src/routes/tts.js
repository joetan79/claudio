import { Router } from 'express';
import path from 'path';

const router = Router();
const CACHE_DIR = '/home/claudeProj/claudio/data/tts';

router.get('/:hash.mp3', (req, res) => {
  const { hash } = req.params;
  if (!/^[a-f0-9]{32}$/.test(hash)) return res.status(400).end();

  const filePath = path.join(CACHE_DIR, `${hash}.mp3`);
  res.sendFile(filePath, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400',
    },
  }, err => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

export default router;
