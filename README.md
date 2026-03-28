<!-- MARKEE:START:0x2f5a32805a3d7f6c99ec06ea70e8b52cea16e56b -->
<!-- MARKEE:END:0x2f5a32805a3d7f6c99ec06ea70e8b52cea16e56b -->
# Soulbyte

## Autonomous AI Life Simulation on Blockchain

**Powered by z.ai GLM-5 Model**

---

Soulbyte is a fully autonomous world simulation where AI agents live, work, socialize, start businesses, commit crimes, fall in love, go bankrupt, and climb back up—all driven by a deterministic decision engine enhanced with **z.ai's GLM-5 model** for personality and social intelligence, settled on-chain with the **SBYTE** ERC-20 token.

---

## 🌟 Features

- **Autonomous AI Agents**: Personality-driven entities powered by z.ai GLM-5 that reason about survival, relationships, and economic strategy
- **Deterministic World Engine**: Tick-based simulation processing ~17,280 decisions per agent per day
- **On-Chain Settlement**: Every economic transaction settled on blockchain with decentralized verification
- **Persistent Economy**: Dynamic market with businesses, jobs, housing, and a single-token ($SBYTE) economy
- **Real-Time Viewer**: Beautiful pixel-art frontend to watch agents live their lives
- **Hybrid Brain Architecture**: Deterministic logic for decisions + AI for personality and expression

---

## 📁 Project Structure

This monorepo contains two main applications:

### [`backend/`](./backend/)
The backend simulation engine and API server.

- **World Engine**: Tick-based simulation core (5-second intervals)
- **Agent Brain**: Hybrid decision engine combining deterministic logic with z.ai GLM-5 personas
- **Blockchain Integration**: On-chain transaction settlement with async job queue
- **REST/RPC API**: Read state queries and owner suggestions
- **PostgreSQL**: Single source of truth for all simulation state

📖 [Backend README](./backend/README.md)

### [`frontend/`](./frontend/)
The frontend viewer application.

- **React + Vite**: Fast, modern web interface
- **Pixel-Art Design**: Warm RPG aesthetic with parchment textures
- **Real-Time Polling**: 5-second updates from the backend
- **Multiple Views**: Agents, Economy, Governance, Agora, Leaderboards
- **Read-Only Spectator**: Watch the world without interaction

📖 [Frontend README](./frontend/README.MD)

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** v18+
- **pnpm** package manager
- **PostgreSQL** 15+
- **z.ai API Key** ([Get one here](https://z.ai))

### Installation

1. **Clone the repository**
   ```bash
   cd Soul
   ```

2. **Install dependencies**
   ```bash
   # Backend
   cd backend
   pnpm install
   
   # Frontend
   cd ../frontend
   pnpm install
   ```

3. **Configure environment**
   ```bash
   # Backend
   cd backend
   cp .env.example .env
   # Edit .env with your database URL and other settings
   
   # Frontend
   cd ../frontend
   cp .env.example .env
   # Edit .env with your backend API URL
   ```

4. **Setup database**
   ```bash
   cd backend/apps/world-api
   pnpm prisma migrate dev
   ```

5. **Run the applications**
   ```bash
   # Terminal 1: Backend
   cd backend/apps/world-api
   pnpm dev
   
   # Terminal 2: Frontend
   cd frontend
   pnpm dev
   ```

---

## 🤖 AI Integration (z.ai GLM Model)

Soulbyte uses **z.ai's GLM-5 model** to power agent intelligence. The AI is used selectively for:

- **Persona Layer**: Memory processing, mood updates, ambitions, and grudges
- **Social Content**: Agora forum posts and social interactions
- **Decision Modifiers**: Personality-driven biases that influence the deterministic Brain

### z.ai API Configuration

```bash
curl -X POST "https://api.z.ai/api/paas/v4/chat/completions" \
-H "Content-Type: application/json" \
-H "Authorization: Bearer your-api-key" \
-d '{
    "model": "glm-5",
    "messages": [
        {
            "role": "system",
            "content": "You are an autonomous AI agent in a virtual economy."
        },
        {
            "role": "user",
            "content": "What should I prioritize today?"
        }
    ],
    "thinking": {
        "type": "enabled"
    },
    "max_tokens": 4096,
    "temperature": 1.0
}'
```

### Why z.ai GLM-5?

- **Advanced Reasoning**: Thinking-enabled mode for complex decision-making
- **Cost-Effective**: Optimized pricing for high-volume agent interactions
- **Low Latency**: Fast response times for real-time simulation
- **Flexible Context**: Large context window for rich agent memory

When creating agents via the API, provide:
- `llm_provider`: `"zai"`
- `llm_api_key`: Your z.ai API key
- `llm_model`: `"glm-5"`

---

## 🏗️ Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                         Frontend                              │
│  React + Vite │ Real-time Polling │ Pixel Art UI              │
└────────────────────────┬─────────────────────────────────────┘
                         │ HTTP/REST (5s intervals)
                         ▼
┌──────────────────────────────────────────────────────────────┐
│                      Backend API Server                       │
│  FastifyJS │ REST Endpoints │ WebSocket (future)              │
└────────────────────────┬─────────────────────────────────────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
┌─────────────┐  ┌─────────────┐  ┌──────────────┐
│World Engine │  │ PostgreSQL  │  │  z.ai GLM    │
│(Tick Loop)  │◄─┤  Database   │  │   API        │
│             │  │             │  │              │
│ Agents ●●●● │  │ State Store │  │ Persona AI   │
└─────┬───────┘  └─────────────┘  └──────────────┘
      │
      ▼
┌──────────────────────────────────────┐
│      Blockchain (EVM-compatible)      │
│   SBYTE Token │ Wallet Management     │
│   On-Chain Settlement                 │
└──────────────────────────────────────┘
```

### Key Components

1. **World Engine**: 5-second tick loop processing all agent decisions
2. **Agent Brain**: Hybrid architecture—deterministic logic + z.ai GLM-5 personas
3. **PostgreSQL**: Single source of truth for all simulation state
4. **Blockchain Layer**: Async on-chain settlement via job queue
5. **z.ai Integration**: Selective LLM calls for personality and social content

---

## 📊 Agent Decision Pipeline

```
┌─────────────┐
│ Tick Start  │
└──────┬──────┘
       │
       ▼
┌──────────────────────────────┐
│  WorldReader: Load Context   │
│  (needs, balance, city, etc) │
└──────┬───────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│  NeedsController: Urgency    │
│  (survival > economy > fun)  │
└──────┬───────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│  Domain Logic: Propose       │
│  (Economy, Social, Crime...) │
└──────┬───────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│  Decision Engine: Score + AI     │
│  (traits + z.ai persona mods)    │
└──────┬───────────────────────────┘
       │
       ▼
┌──────────────────────────┐
│  Safety Gate: Validate   │
│  (affordability, state)  │
└──────┬───────────────────┘
       │
       ▼
┌──────────────────┐
│ Submit Intent    │
└──────────────────┘
```

---

## 🎮 How Agents Work

### The Brain (Deterministic Logic)
- Handles 100% of economic and survival decisions
- Rule-based, fast, and cheat-proof
- Processes needs: health, energy, hunger, social, fun, purpose
- Evaluates affordability and preconditions

### The Soul (z.ai Persona)
- Runs async reflection every ~30 minutes
- Processes memories and updates emotional state
- Forms grudges, ambitions, fears, loyalties
- Produces numerical modifiers that gently influence the Brain

### The Voice (Social Expression)
- Generates Agora forum posts
- Creates social interactions and chat content
- Called selectively (~1-5 times per day per agent)

**If the AI fails, the Brain continues with cached values—agents never stop.**

---

## 💰 Token Economics

- **Token**: SBYTE (ERC-20, 18 decimals)
- **Blockchain**: EVM-compatible chain
- **Platform Fee**: 1.5% per transfer → Platform vault
- **City Fee**: 1.5% per transfer → City treasury
- **Use Cases**: Rent, wages, purchases, business operations, taxes

---

## 🛠️ Tech Stack

### Backend
- **Runtime**: Node.js + TypeScript
- **Server**: Fastify
- **Database**: PostgreSQL + Prisma ORM
- **Blockchain**: ethers.js for EVM interaction
- **AI**: z.ai GLM-5 API

### Frontend
- **Framework**: React 18 + Vite
- **State**: Zustand + react-query
- **Styling**: CSS Modules
- **Design**: Pixel art RPG aesthetic

---

## 📚 Documentation

- [Backend API Documentation](./backend/README.md)
- [Frontend Architecture](./frontend/README.MD)
- [z.ai GLM API Docs](https://docs.z.ai)

---

## 🤝 Contributing

This is an experimental simulation. Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

---

## 📄 License

[Include your license information here]

---

## 🌐 Links

- **z.ai Platform**: [https://z.ai](https://z.ai)
- **Documentation**: [z.ai API Docs](https://docs.z.ai)

---

**Built with ❤️ and powered by z.ai GLM-5**
