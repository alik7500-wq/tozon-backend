import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import pino from 'pino-http';
import path from 'path';
import { fileURLToPath } from 'url';
import { errorHandler } from './shared/errors/errorHandler.js';

import authRouter from './modules/auth/auth.router.js';
import projectsRouter from './modules/projects/projects.router.js';
import inventoryRouter from './modules/inventory/inventory.router.js';
import visualMapsRouter from './modules/visual-maps/visual-maps.router.js';
import leadsRouter from './modules/leads/leads.router.js';
import dealsRouter from './modules/deals/deals.router.js';
import dashboardRouter from './modules/dashboard/dashboard.router.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadDir = path.resolve(__dirname, '../../../data/uploads');

const app = express();

// Middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());
app.use(pino({
  autoLogging: {
    ignore: (req) => req.url === '/api/health',
  }
}));

// Static files for uploads
app.use('/uploads', express.static(uploadDir));

// Routes
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/visual-maps', visualMapsRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/deals', dealsRouter);
app.use('/api/dashboard', dashboardRouter);

// Global Error Handler
app.use(errorHandler);

export { app };
