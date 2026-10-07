module.exports = {
  apps: [{
    name: 'vocal-study-planner',
    cwd: __dirname,
    script: 'start.js',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '200M',
    env: { NODE_ENV: 'production', PORT: '3010', DB_PATH: '/var/lib/vocal-study-planner/vocal.db' }
  }]
};
