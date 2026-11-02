module.exports = {
  apps: [{
    name: 'jbdesk-server', cwd: __dirname, script: 'server.js',
    interpreter: process.env.JBREMOTE_NODE || '/opt/jbremote-node/bin/node',
    exec_mode: 'fork', instances: 1, autorestart: true, watch: false,
    max_memory_restart: '256M', kill_timeout: 5000,
    time: true, env: {
      NODE_ENV: 'production', HOST: '127.0.0.1', PORT: 3001,
      TRUSTED_PROXIES: '127.0.0.1', DATA_DIR: '/home/ubuntu/.local/share/jbremote'
    }
  }]
};
