// `bun run ui`: bundles and serves the watch-only page (ADR 0020). The page
// fetches its NATS websocket URL from /config.json, so the bundle stays the
// same whatever the env. Exit code 2: invalid config.
import * as z from "zod";
import page from "./index.html";

const Env = z.object({
	NATS_WS_URL: z.url({ protocol: /^wss?$/ }),
	UI_PORT: z
		.string()
		.regex(z.regexes.integer, { error: "expected an integer" })
		.transform(Number)
		.pipe(z.int().min(1).max(65535))
		.default(3000),
});

const env = Env.safeParse(Bun.env);
if (!env.success) {
	console.log(
		JSON.stringify({
			service: "ui",
			type: "invalid_config",
			issues: env.error.issues.map((issue) => ({
				variable: String(issue.path[0]),
				message: issue.message,
			})),
		}),
	);
	process.exit(2);
}

const server = Bun.serve({
	port: env.data.UI_PORT,
	routes: {
		"/": page,
		"/config.json": Response.json({ natsWsUrl: env.data.NATS_WS_URL }),
	},
});
console.log(
	JSON.stringify({ service: "ui", type: "started", url: server.url.href }),
);
