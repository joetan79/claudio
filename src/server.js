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

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3001;

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

app.listen(PORT, () => {
  console.log(`Claudio running on :${PORT}`);
});
