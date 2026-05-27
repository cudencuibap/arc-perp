import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { EngineEvent, MarketWorldState } from "@arc-perp/core";
import "./styles.css";

const wsUrl = import.meta.env.VITE_WS_URL ?? "ws://localhost:4100/ws";

function Visualizer() {
  const [world, setWorld] = useState<MarketWorldState>();
  const [events, setEvents] = useState<string[]>([]);
  useEffect(() => {
    const socket = new WebSocket(wsUrl);
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data) as EngineEvent;
      setEvents((prev) => [event.type, ...prev].slice(0, 30));
      if (event.type === "world") setWorld(event.payload);
    };
    return () => socket.close();
  }, []);
  return <main>
    <h1>Market World</h1>
    <section className="map">
      {world?.districts.map((district) => <article key={district.id} style={{ backgroundColor: `rgba(240, 184, 77, ${0.12 + district.activity * 0.55})` }}>
        <strong>{district.label}</strong><span>Activity {(district.activity * 100).toFixed(0)}%</span>
      </article>)}
      {world?.agents.map((agent) => <i key={agent.id} style={{ left: `${agent.x}%`, top: `${agent.y}%` }} />)}
    </section>
    <aside>{events.map((event, index) => <span key={`${event}-${index}`}>{event}</span>)}</aside>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Visualizer />);
