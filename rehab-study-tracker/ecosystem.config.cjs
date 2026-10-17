module.exports = {
  apps: [{
    name: 'rehab-study-tracker',
    cwd: __dirname,
    script: 'start.js',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '200M',
    env: {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '3011',
      DATABASE_FILE: '/var/lib/rehab-study-tracker/rehab.db'
    }
  }]
};
