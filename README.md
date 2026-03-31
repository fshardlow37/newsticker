# newsticker

A compact, always-on-top desktop news ticker for Windows. Aggregates headlines from multiple news APIs and RSS feeds, then uses a local Ollama LLM to filter and summarize the 7 most globally significant stories.

## Features

- Always-on-top frameless window with draggable titlebar
- AI-powered headline curation via local Ollama (llama3.2:3b)
- 5 news APIs + 14 RSS feeds for broad coverage
- Color-coded categories: global, science, interests, future, general
- Breaking news and developing story indicators
- Auto-refreshes every 15 minutes
- Remembers window position and size between sessions
- Graceful fallback to raw headlines when Ollama is unavailable
- Zero runtime dependencies

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Ollama](https://ollama.ai/) installed and running locally

## Setup

### 1. Install Ollama

Download and install from [ollama.ai](https://ollama.ai/), then pull the model:

```bash
ollama pull llama3.2:3b
```

Ollama runs as a background service automatically after installation. Verify it's running:

```bash
curl http://localhost:11434/api/version
```

### 2. Get API keys

Sign up for free API keys at each service:

| Service  | Sign up                                       | Env variable    |
|----------|-----------------------------------------------|-----------------|
| NewsAPI  | https://newsapi.org/register                  | `NEWSAPI_KEY`   |
| GNews    | https://gnews.io/register                     | `GNEWS_KEY`     |
| Guardian | https://open-platform.theguardian.com/access/ | `GUARDIAN_KEY`  |
| NYTimes  | https://developer.nytimes.com/accounts/create | `NYTIMES_KEY`   |
| Currents | https://currentsapi.services/en/register      | `CURRENTS_KEY`  |

### 3. Configure environment

Copy the example file and fill in your keys:

```bash
cp .env.example .env
```

Edit `.env` with your API keys. This file is gitignored and will not be committed.

### 4. Install dependencies

```bash
npm install
```

## Usage

### Run in development

```bash
npm start
```

### Build portable exe

```bash
npm run build
```

Creates `build/newsticker.exe` -- a single portable Windows executable.

### Portable exe configuration

The portable exe looks for API keys in this order:

1. System environment variables
2. `.env` file in `%APPDATA%/newsticker/`

To use the portable exe, either set the env variables system-wide or place a `.env` file (same format as `.env.example`) in your `%APPDATA%/newsticker/` folder.

## How it works

1. Fetches headlines from 5 APIs and 14 RSS feeds in parallel
2. Filters to articles published in the last 24 hours
3. Deduplicates and ranks by cross-source coverage (stories covered by multiple sources rank higher)
4. Pre-filters to the top ~20 most significant stories
5. Sends to local Ollama (llama3.2:3b) to select and rewrite the top 7
6. Displays in a compact always-on-top window with category color indicators
7. Refreshes every 15 minutes

## License

MIT
