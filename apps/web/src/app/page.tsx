import { BaseMap } from "@/components/base-map";
import { SocketProvider } from "@/lib/socket-provider";

// No backend Socket.io gateway exists yet (fusion-svc/an API gateway would
// emit these events in a later phase) — this stays undefined until one
// does, which SocketProvider treats as "don't connect" rather than erroring.
const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL;

export default function DashboardPage() {
  return (
    <SocketProvider url={SOCKET_URL}>
      <main style={{ width: "100vw", height: "100vh" }}>
        <BaseMap />
      </main>
    </SocketProvider>
  );
}
