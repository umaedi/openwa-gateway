module.exports = {
  apps: [
    {
      name: 'openwa-gateway',
      script: 'dist/main.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '800M',
      env: {
        NODE_ENV: 'production',
        PORT: 2785,
        NODE_OPTIONS: '--max-old-space-size=768',
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
