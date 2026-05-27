# WebSocket API

Clients connect to:

```text
ws://localhost:4100/ws
```

The gateway forwards events from the matching engine and sends JSON envelopes:

```json
{ "type": "trade", "payload": { "symbol": "BTC-PERP", "price": 68000, "quantity": 0.1 } }
```

Event types:

- `state`: initial market snapshot.
- `orderbook`: top aggregated book levels for one market.
- `trade`: realtime fill from the centralized matching engine.
- `position`: updated position with mark price, unrealized PnL, margin, and liquidation price.
- `balance`: fake simulation balance update.
- `mark`: simulated oracle or index price update.
- `liquidation`: liquidation simulation event.
- `world`: district heatmap and agent movement state.

Order submission is REST in Phase 1:

```http
POST http://localhost:4100/api/orders
content-type: application/json
```

```json
{
  "traderId": "human-demo",
  "symbol": "BTC-PERP",
  "side": "buy",
  "type": "limit",
  "quantity": 0.1,
  "price": 68000,
  "leverage": 10
}
```

Market orders omit `price` and cross the current in-memory book.
