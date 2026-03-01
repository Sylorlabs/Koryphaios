module.exports = {
  apps: [
    {
      name: "kory-backend",
      cwd: __dirname,
      script: "bun",
      args: "run --filter backend dev",
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "development",
        KORYPHAIOS_HOST: "0.0.0.0"
      }
    },
    {
      name: "kory-frontend",
      cwd: __dirname,
      script: "bun",
      args: "run --filter frontend dev",
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "development"
      }
    }
  ]
}
