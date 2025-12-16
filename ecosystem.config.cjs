/**
 * PM2 Ecosystem Configuration for Manowar Server
 *
 * Manages the manowar agent orchestration service.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 restart manowar
 *   pm2 stop manowar
 *   pm2 logs manowar
 */
module.exports = {
    apps: [
        {
            name: "manowar",
            script: "dist/server.js",
            cwd: "/home/ubuntu/manowar",
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: "1G",
            env: {
                NODE_ENV: "production",
            },
            error_file: "/home/ubuntu/logs/manowar-error.log",
            out_file: "/home/ubuntu/logs/manowar-out.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss Z",
        },
    ],
};
