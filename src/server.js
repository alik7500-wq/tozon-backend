import { app } from './app.js';
import { connectDB } from './db/connection.js';
import { runTour30StageIfEnabled } from './operations/runTour30Stage.js';
import { startFinanceBot } from './modules/telegram-finance/start.js';
import { DistributionSettingsService } from './modules/leads/distributionSettings.service.js';

const PORT = process.env.PORT || 3000;

const startServer = async () => {
  try {
    // Initialize DB Connection
    connectDB();

    // Preload persistent distribution settings from PostgreSQL
    try {
      const initialSettings = await DistributionSettingsService.initSettings();
      console.log(`[DistributionSettings] Loaded from PostgreSQL: enabled=${initialSettings.enabled}, algorithm=${initialSettings.algorithm}, maxCapacity=${initialSettings.maxOpenLeadsPerRep}`);
    } catch (err) {
      console.warn('[DistributionSettings] Could not preload settings on startup:', err.message);
    }
    
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      startFinanceBot();
      runTour30StageIfEnabled().catch(error => console.error('TOUR30_STORAGE_STAGE_FAILED', error.message));
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
