// `bun run ui`: bundles and serves the watch-only page (ADR 0020). The page
// fetches its NATS websocket URL from /config.json, so the bundle stays the
// same whatever the env. Exit code 2: invalid config.
import { parseUiConfig } from "../sim/config.ts";
import { orExit } from "../sim/process.ts";
import page from "./index.html";

const config = orExit("ui", parseUiConfig(Bun.env));

const server = Bun.serve({
	port: config.port,
	routes: {
		"/": page,
		"/config.json": Response.json({ natsWsUrl: config.natsWsUrl }),
	},
});
console.log(
	JSON.stringify({ service: "ui", type: "started", url: server.url.href }),
);
