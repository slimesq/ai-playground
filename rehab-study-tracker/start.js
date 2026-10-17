import { createStudyServer } from './server.js';

const port = Number(process.env.PORT || 3011);
const host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('PORT 须为 0–65535 的整数。');
  process.exitCode = 1;
} else {
  const server = createStudyServer();
  server.on('error', () => { console.error('无法启动康复学习服务。'); process.exitCode = 1; });
  server.listen(port, host, () => console.log(`康复学习服务已启动：http://${host}:${server.address().port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
