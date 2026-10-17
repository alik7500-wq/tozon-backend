import { app } from './app.js';
import { connectDB } from './db/connection.js';
import { runTour30StageIfEnabled } from './operations/runTour30Stage.js';
import { startFinanceBot } from './modules/telegram-finance/start.js';

const PORT = process.env.PORT || 3000;

const startServer = () => {
  try {
    // Initialize DB Connection
    connectDB();
    
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
