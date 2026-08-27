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
import usersRouter from './modules/users/users.router.js';
import tasksRouter from './modules/tasks/tasks.router.js';
import contractsRouter from './modules/contracts/contracts.router.js';
import financeRouter from './modules/finance/finance.router.js';
import reportsRouter from './modules/reports/reports.router.js';
import notificationsRouter from './modules/notifications/notifications.router.js';
import apartmentsRouter from './modules/apartments/apartments.router.js';
import { automationRouter } from './modules/automation/automation.router.js';
import uploadRouter from './modules/upload/upload.routes.js';
import dictionariesRouter from './modules/dictionaries/dictionaries.router.js';
import visual3dRouter from './modules/visual3d/visual3d.router.js';
import tour360Router from './modules/tour360/tour360.router.js';
import projectMediaRouter from './modules/projectMedia/projectMedia.router.js';
import searchRouter from './modules/search/search.router.js';

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
app.get('/', (req, res) => {
  res.status(200).send('API is running');
});

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
app.use('/api/users', usersRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/contracts', contractsRouter);
app.use('/api/finance', financeRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/apartments', apartmentsRouter);
app.use('/api/automation', automationRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/dictionaries', dictionariesRouter);
app.use('/api', visual3dRouter);
app.use('/api', tour360Router);
app.use('/api', projectMediaRouter);
app.use('/api/search', searchRouter);

// Global Error Handler
app.use(errorHandler);

export { app };
