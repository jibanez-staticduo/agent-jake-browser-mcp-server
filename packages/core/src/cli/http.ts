import { createHttpServer } from '../http/server.js';

const server = createHttpServer();
server.listen().catch(async (error) => {
  console.error('HTTP server startup failed', error);
  await server.close();
  process.exitCode = 1;
});
