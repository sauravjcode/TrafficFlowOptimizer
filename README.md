# Traffic Flow Optimizer

A full-featured urban traffic signal timing optimization simulator built with React.

## Features

- **Queue Length Modeling** — Webster's delay formula calculates avg wait time, queue depth, and V/C ratio per lane
- **Dynamic Signal Timing Optimization** — Proportional green time redistribution using Webster's optimal cycle
- **Traffic Density Levels** — Per-lane density (Low / Medium / High / Peak Hour) with multipliers
- **Lane Types** — Straight and Turn lanes with type-specific flow penalties
- **Before vs After Comparison** — Wait time bars, circular gauges, and full metrics table
- **Congestion Reduction Estimation** — Explicit % reduction metric with visual gauge
- **Traffic Load Balancing** — Side-by-side load bars showing capacity rebalancing
- **Queue Build-Up Time Series** — Sparkline chart over 20 simulated cycles
- **Throughput Gain** — System-level vehicles-per-cycle before/after
- **4-Tab Dashboard** — Configure → Simulate → Results → History
- **Simulation History** — Every run stored and reloadable
- **Live Intersection Visualizer** — Animated vehicles + cycling traffic signals

## Getting Started

### Prerequisites

- Node.js 16+ and npm

### Install & Run

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) to view it in your browser.

### Build for Production

```bash
npm run build
```

## Usage

1. **Configure** — Set lanes, vehicle counts, green times, and density levels. Click lane names to rename them. Toggle between Straight/Turn types.
2. **Simulate** — Review parameters and click **Run Optimization Simulation**. Watch the 4-phase progress (Queue Modeling → Timing Optimizer → Congestion Estimation → Load Balancing).
3. **Results** — View all Before vs After metrics: wait times, congestion %, throughput gain, load balancing, and time-series queue chart.
4. **History** — Every run is saved with full metrics. Load any past run back into the Results view.

## How the Simulation Works

- **Queue model**: Webster's delay formula — `d = C(1-g/C)² / 2(1-ρ·g/C)` where ρ = V/C ratio
- **Optimal cycle**: Webster's formula `C = (1.5L + 5) / (1 - ΣY)` 
- **Green time allocation**: Proportional to adjusted flow rates per lane
- **Density multipliers**: Low=0.5×, Medium=1.0×, High=1.5×, Peak=2.2×
- **Turn lane penalty**: 1.3× flow adjustment for turning movements

## Tech Stack

- React 18
- Pure CSS-in-JS (no UI library dependencies)
- SVG for intersection visualization and charts
