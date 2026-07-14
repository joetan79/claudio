import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getSystemDb } from './db/index.js';
import authRouter from './routes/auth.js';
import radioRouter from './routes/radio.js';
import profileRouter from './routes/profile.js';
import ttsRouter from './routes/tts.js';
import adminRouter from './routes/admin.js';
import { startScheduler } from './modules/scheduler.js';
import { isEncryptionEnabled } from './modules/crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Defense-in-depth backstop: an uncaught exception or unhandled rejection
// anywhere (e.g. a route handler's synchronous throw that no try/catch
// wraps) must never take the whole process down and every other user's
// in-flight request with it. Log and keep running — the request that
// triggered it is handled (or left to time out) at the route level;
// individual routes are still responsible for returning a clean error
// response, this is only the last resort against a process-wide crash.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const app = express();
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '127.0.0.1';

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

app.use('/api/auth', authRouter);
app.use('/api/radio', radioRouter);
app.use('/api/profile', profileRouter);
app.use('/api/tts', ttsRouter);
app.use('/api/admin', adminRouter);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'claudio', ts: Date.now() });
});

// Static files (admin.html served here as /admin.html; /admin clean URL below)
app.use(express.static(join(__dirname, '../public')));

// /admin clean URL — must be before the SPA catch-all
app.get('/admin', (req, res) => {
  res.sendFile(join(__dirname, '../public/admin.html'));
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, '../public/index.html'));
});

getSystemDb();
startScheduler();

if (!isEncryptionEnabled()) {
  console.warn('[Claudio] APP_ENCRYPTION_KEY not set — BYO API key feature disabled');
}

app.listen(PORT, HOST, () => {
  console.log(`Claudio running on ${HOST}:${PORT}`);
});
