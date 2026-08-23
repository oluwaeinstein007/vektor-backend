import { BaseMap } from "@/components/base-map";
import { SocketProvider } from "@/lib/socket-provider";

// fusion-svc (Phase 3) is the Socket.io gateway — point this at it
// (default http://localhost:3007). Left unset, SocketProvider treats that
// as "don't connect" rather than erroring, so local dev without fusion-svc
// running still works (just no live entity updates).
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
