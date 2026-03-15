const http = require("http");
const { URL } = require("url");
const { handler } = require("./handler");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || "8787");

function buildEvent(req, bodyText) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return {
    rawPath: url.pathname,
    queryStringParameters: Object.fromEntries(url.searchParams.entries()),
    headers: req.headers,
    body: bodyText || "",
    requestContext: {
      http: {
        method: req.method
      }
    }
  };
}

const server = http.createServer((req, res) => {
  let bodyText = "";

  req.on("data", (chunk) => {
    bodyText += chunk;
  });

  req.on("end", async () => {
    try {
      const response = await handler(buildEvent(req, bodyText));
      res.writeHead(response.statusCode || 200, response.headers || {});
      res.end(response.body || "");
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify(
          {
            ok: false,
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: error instanceof Error ? error.message : "Unknown error",
              retryable: false
            },
            serverTime: new Date().toISOString()
          },
          null,
          2
        )
      );
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Omojan mock API listening on http://${HOST}:${PORT}`);
});
