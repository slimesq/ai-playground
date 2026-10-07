import { createStudyServer } from './server.js';

const port = Number(process.env.PORT || 3010);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('PORT 须为 0–65535 的整数。');
  process.exitCode = 1;
} else {
  const server = createStudyServer();
  server.on('error', () => { console.error('无法启动声乐学习服务。'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`声乐学习服务已启动：http://127.0.0.1:${server.address().port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
