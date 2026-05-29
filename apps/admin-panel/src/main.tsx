import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { RadioTower } from "lucide-react";
import "./styles.css";

const API_BASE_URL = import.meta.env.VITE_API_URL ?? "";

function Admin() {
  const [state, setState] = useState<{ positions: unknown[]; balances: unknown[]; trades: unknown[]; books: unknown[] }>();
  useEffect(() => {
    const id = setInterval(() => fetch(`${API_BASE_URL}/api/state`).then((res) => res.json()).then(setState).catch(() => undefined), 1000);
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
