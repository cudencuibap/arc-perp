import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { RadioTower } from "lucide-react";
import "./styles.css";

const isLocalHost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const MATCHING_ENGINE_URL = import.meta.env.VITE_MATCHING_ENGINE_URL ?? (isLocalHost ? "http://localhost:4101" : "https://arc-perp-matching-engine.onrender.com");

function Admin() {
  const [state, setState] = useState<{ positions: unknown[]; balances: unknown[]; trades: unknown[]; books: unknown[] }>();
  useEffect(() => {
    const id = setInterval(() => fetch(`${MATCHING_ENGINE_URL}/state`).then((res) => res.json()).then(setState).catch(() => undefined), 1000);
    return () => clearInterval(id);
  }, []);
  return <main>
    <header><RadioTower /><h1>Arc Perp Admin</h1></header>
    <section>
      <Card label="Markets" value={state?.books.length ?? 0} />
      <Card label="Positions" value={state?.positions.length ?? 0} />
      <Card label="Balances" value={state?.balances.length ?? 0} />
      <Card label="Trades" value={state?.trades.length ?? 0} />
    </section>
    <pre>{JSON.stringify(state, null, 2)}</pre>
  </main>;
}

function Card({ label, value }: { label: string; value: number }) {
  return <article><span>{label}</span><strong>{value}</strong></article>;
}

createRoot(document.getElementById("root")!).render(<Admin />);
