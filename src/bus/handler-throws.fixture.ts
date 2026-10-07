// Spawned by nats.test.ts: a NATS bus whose handler throws (a bug). The bus
// must surface it outside the client, so this process exits non-zero.
import * as z from "zod";
import { RunId, TripId } from "../shared/messages.ts";
import { Region } from "../shared/regions.ts";
import { connectNatsBus } from "./nats.ts";

const url = z.url().parse(Bun.env.NATS_URL);
const tripId = TripId.parse(z.string().parse(Bun.argv[2]));
const connected = await connectNatsBus({
	url,
	runId: RunId.parse("handler-throws"),
	inputs: ["cancel_trip"],
	log: () => {},
	logStatus: () => {},
	logTiming: () => {},
});
if (!connected.ok) throw new Error("NATS unavailable", { cause: connected });
const bus = connected.value;
bus.subscribe(["cancel_trip"], (message) => {
	if (message.tripId === tripId) throw new Error("handler bug");
});
bus.publish({ type: "cancel_trip", tripId, region: Region.parse(0) });
await Bun.sleep(500);
await bus.close();
