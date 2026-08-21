import { io, type Socket } from "socket.io-client";
import type { ServerToClientEvents, ClientToServerEvents } from "./socket-types.ts";
import { S2CSchemas } from "./socket-types.ts";

export type VektorSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function createVektorSocket(url: string): VektorSocket {
  return io(url, { transports: ["websocket"] });
}

/**
 * Subscribes to a server->client event with Zod validation on every
 * message. socket.io-client's typed `.on()` only guards code on the
 * emitting side — a malformed payload arriving over the wire would
 * otherwise reach `handler` as-is. §10.1 calls for "runtime schema
 * validation on all API responses"; a WebSocket push is exactly as much of
 * a trust boundary as a REST response, so it gets the same treatment here.
 * A payload that fails validation is dropped and reported via `onInvalid`
 * rather than reaching `handler`.
 */
export function onValidated<K extends keyof ServerToClientEvents>(
  socket: VektorSocket,
  event: K,
  handler: ServerToClientEvents[K],
  onInvalid?: (event: K, error: unknown) => void,
): () => void {
  const schema = S2CSchemas[event];
  const listener = (payload: unknown) => {
    const result = schema.safeParse(payload);
    if (!result.success) {
      onInvalid?.(event, result.error);
      return;
    }
    (handler as (parsed: unknown) => void)(result.data);
  };

  // socket.io-client's .on/.off overloads don't resolve cleanly against a
  // generic K extends keyof ServerToClientEvents at the call site (a known
  // rough edge with its ReservedOrUserEventNames constraint) — event is
  // narrowed to a real member of ServerToClientEvents by the K constraint
  // above, so this cast is just working around that inference gap, not
  // widening what values are actually accepted.
  socket.on(event as keyof ServerToClientEvents, listener as never);
  return () => {
    socket.off(event as keyof ServerToClientEvents, listener as never);
  };
}
