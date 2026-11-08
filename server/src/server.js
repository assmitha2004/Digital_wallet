import { app } from './app.js';
import { config } from './config.js';

app.listen(config.port, () => {
  console.log(`PayLedger API listening on http://localhost:${config.port}`);
});
