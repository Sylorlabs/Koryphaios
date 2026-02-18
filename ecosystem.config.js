module.exports = {
  apps: [
    {
      name: "kory-backend",
      cwd: "/home/micah/Desktop/sylorlabs projects/Koryphaios",
      script: "bun",
      args: "run --filter backend dev",
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "development"
      }
    },
    {
      name: "kory-frontend",
      cwd: "/home/micah/Desktop/sylorlabs projects/Koryphaios",
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
