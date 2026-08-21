"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createVektorSocket, type VektorSocket } from "./socket-client";

const SocketContext = createContext<VektorSocket | null>(null);

/**
 * One Socket.io connection shared by every feature that needs live updates
 * (entity layer, sensor health panel, future alert/COA panels) — each
 * feature subscribes to its own event names on this one socket rather than
 * opening a separate connection per feature.
 */
export function SocketProvider({ url, children }: { url: string | undefined; children: ReactNode }) {
  const [socket, setSocket] = useState<VektorSocket | null>(null);

  useEffect(() => {
    if (!url) return;
    const instance = createVektorSocket(url);
    setSocket(instance);
    return () => {
      instance.disconnect();
      setSocket(null);
    };
  }, [url]);

  return <SocketContext.Provider value={socket}>{children}</SocketContext.Provider>;
}

export function useVektorSocket(): VektorSocket | null {
  return useContext(SocketContext);
}
