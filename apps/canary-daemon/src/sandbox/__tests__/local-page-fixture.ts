import { createServer } from "node:http";

// Exercise real navigation without depending on external DNS or example.com availability.
export async function localPageFixture() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      "<!doctype html><title>Example Domain</title><h1>Example Domain</h1><p>Local navigation fixture.</p>"
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture did not bind");
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
