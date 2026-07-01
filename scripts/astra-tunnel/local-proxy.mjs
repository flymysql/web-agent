/**
 * Rewrites Host to astra.woa.com and forwards to the SSH tunnel on 127.0.0.1:15722.
 * Node fetch cannot override Host; curl can, but web-agent uses fetch.
 *
 * Listen:  http://127.0.0.1:15723/astra-llm/v1  ->  tunnel :15722  ->  astra.woa.com
 */
import http from 'node:http';

const LISTEN_HOST = process.env.ASTRA_PROXY_HOST ?? '127.0.0.1';
const LISTEN_PORT = parseInt(process.env.ASTRA_PROXY_PORT ?? '15723', 10);
const TUNNEL_HOST = process.env.ASTRA_TUNNEL_HOST ?? '127.0.0.1';
const TUNNEL_PORT = parseInt(process.env.ASTRA_TUNNEL_PORT ?? '15722', 10);
const UPSTREAM_HOST = process.env.ASTRA_UPSTREAM_HOST ?? 'astra.woa.com';

const server = http.createServer((clientReq, clientRes) => {
  const headers = { ...clientReq.headers, host: UPSTREAM_HOST };
  delete headers['proxy-connection'];

  const upstream = http.request(
    {
      hostname: TUNNEL_HOST,
      port: TUNNEL_PORT,
      path: clientReq.url,
      method: clientReq.method,
      headers,
    },
    (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(clientRes);
    }
  );

  upstream.on('error', (err) => {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      clientRes.end(
        `Bad gateway to SSH tunnel ${TUNNEL_HOST}:${TUNNEL_PORT}: ${err.message}\n` +
          `Is start-tunnel.ps1 running?\n`
      );
    }
  });

  clientReq.pipe(upstream);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(
    `[astra-local-proxy] http://${LISTEN_HOST}:${LISTEN_PORT} -> tunnel :${TUNNEL_PORT} (Host: ${UPSTREAM_HOST})`
  );
});

server.on('error', (err) => {
  if (err && 'code' in err && err.code === 'EADDRINUSE') {
    console.error(
      `[astra-local-proxy] Port ${LISTEN_PORT} is already in use.\n` +
        `  Another proxy is probably still running. Either:\n` +
        `    - use it as-is (LLM_BASE_URL=http://127.0.0.1:${LISTEN_PORT}/astra-llm/v1), or\n` +
        `    - run: .\\scripts\\astra-tunnel\\stop-all.ps1\n`
    );
    process.exit(1);
  }
  throw err;
});
