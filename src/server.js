import { app } from './app.js';
import { connectDB } from './db/connection.js';

const PORT = process.env.PORT || 3000;

const startServer = () => {
  try {
    // Initialize DB Connection
    connectDB();
    
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
