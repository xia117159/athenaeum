import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function formatListenError(error, host, port) {
  if (error?.code !== "EADDRINUSE") {
    return error?.message ?? String(error);
  }

  return [
    `端口已被占用：${host}:${port}`,
    "请先关闭之前启动的开发服务器，或执行：",
    `Get-NetTCPConnection -LocalAddress ${host} -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object OwningProcess`,
    "Stop-Process -Id <PID> -Force"
  ].join("\n");
}

function normalizeUrlPath(reqUrl) {
  const url = new URL(reqUrl ?? "/", "http://127.0.0.1");
  return url.pathname === "/" ? "/index.html" : url.pathname;
}

function createStaticDevServer(distDir) {
  return http.createServer(async (req, res) => {
    const urlPath = normalizeUrlPath(req.url);
    const filePath = path.join(distDir, urlPath);

    try {
      const buffer = await fs.readFile(filePath);
      res.setHeader("Content-Type", mimeTypes[path.extname(filePath)] ?? "application/octet-stream");
      res.end(buffer);
    } catch {
      res.statusCode = 404;
      res.end("Not found");
    }
  });
}

export function startStaticDevServer({ distDir, host = "127.0.0.1", port = 1420 }) {
  const server = createStaticDevServer(distDir);

  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      error.message = formatListenError(error, host, port);
      reject(error);
    });

    server.listen(port, host, () => {
      server.removeAllListeners("error");
      server.on("error", (error) => {
        console.error(error);
      });
      resolve(server);
    });
  });
}
