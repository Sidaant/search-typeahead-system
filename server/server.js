import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { Database } from './db.js';
import { ConsistentHashRing } from './consistentHash.js';
import { TrendingTracker } from './trending.js';
import { BatchWriter } from './batchWriter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Initialize Trie Database pointing to data/queries.csv (fallback/seed source)
const csvPath = path.join(__dirname, '..', 'data', 'queries.csv');
const db = new Database(csvPath);

// Initialize Consistent Hash Ring with 4 logical cache nodes
const ring = new ConsistentHashRing(32); // 32 virtual nodes per physical node

// Configure Redis connections from Environment Variables or fall back to localhost
const redisHostsEnv = process.env.REDIS_HOSTS;
if (redisHostsEnv) {
  // Docker network configuration (e.g. "redis-1:6379,redis-2:6379,redis-3:6379,redis-4:6379")
  const hostPorts = redisHostsEnv.split(',');
  hostPorts.forEach((hp, idx) => {
    const [host, portStr] = hp.split(':');
    const port = parseInt(portStr, 10) || 6379;
    const nodeId = `CacheNode_${idx + 1}`;
    ring.addNode(nodeId, { host, port });
  });
  console.log('Consistent Hash Ring configured with containerized Redis nodes.');
} else {
  // Local development configuration (assumes redis runs on localhost on ports 6379, 6380, 6381, 6382)
  ring.addNode('CacheNode_1', { host: '127.0.0.1', port: 6379 });
  ring.addNode('CacheNode_2', { host: '127.0.0.1', port: 6380 });
  ring.addNode('CacheNode_3', { host: '127.0.0.1', port: 6381 });
  ring.addNode('CacheNode_4', { host: '127.0.0.1', port: 6382 });
  console.log('Consistent Hash Ring configured with localhost Redis nodes.');
}

const trendingTracker = new TrendingTracker(2 * 60 * 1000); // 2 minute sliding window
const batchWriter = new BatchWriter(db, 5000, 20); // Flush every 5s or 20 writes

// Latency tracking
const latencyHistory = [];
function recordLatency(ms) {
  latencyHistory.push(ms);
  if (latencyHistory.length > 500) {
    latencyHistory.shift();
  }
}

function getLatencyMetrics() {
  if (latencyHistory.length === 0) return { avg: 0, p95: 0, p99: 0 };
  const sorted = [...latencyHistory].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = sum / sorted.length;
  const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  const p99Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));
  return {
    avg: parseFloat(avg.toFixed(2)),
    p95: parseFloat(sorted[p95Idx].toFixed(2)),
    p99: parseFloat(sorted[p99Idx].toFixed(2))
  };
}

// Invalidate prefix suggestions cached on Redis nodes when a query's count changes
async function invalidateCacheForQuery(query) {
  const cleanQuery = query.trim().toLowerCase();
  // Generate all prefixes of the query, including empty prefix
  for (let i = 0; i <= cleanQuery.length; i++) {
    const prefix = cleanQuery.substring(0, i);
    try {
      const { node } = ring.getNode(prefix);
      await node.delete(`${prefix}:basic`);
      await node.delete(`${prefix}:trending`);
    } catch (e) {
      // Ignore routing errors
    }
  }
}

// 1. GET /suggest?q=<prefix>&mode=<basic|trending>
app.get('/suggest', async (req, res) => {
  const start = performance.now();
  const q = (req.query.q || '').trim().toLowerCase();
  const mode = req.query.mode === 'trending' ? 'trending' : 'basic';
  const cacheKey = `${q}:${mode}`;

  try {
    // Determine which cache node owns this prefix
    const route = ring.getNode(q);
    const node = route.node;

    // Check Redis Cache (asynchronous)
    let suggestions = await node.get(cacheKey);
    let cacheHit = true;

    if (!suggestions) {
      cacheHit = false;
      // Cache Miss: Query Database Index
      if (mode === 'trending') {
        const candidates = db.getPrefixMatches(q, 200);
        suggestions = trendingTracker.rankSuggestions(candidates, q, 5000);
      } else {
        suggestions = db.suggest(q);
      }
      
      // Store in routed Redis node
      await node.set(cacheKey, suggestions, 30000); // 30 seconds TTL
    }

    const latency = performance.now() - start;
    recordLatency(latency);

    return res.json({
      suggestions,
      latencyMs: parseFloat(latency.toFixed(3)),
      cache: {
        status: cacheHit ? 'hit' : 'miss',
        nodeId: node.nodeId,
        vNodeHash: route.debug.vNodeHash,
        keyHash: route.debug.keyHash
      }
    });
  } catch (error) {
    console.error('Error serving suggestions:', error);
    return res.status(500).json({ error: error.message });
  }
});

// 2. POST /search
app.post('/search', async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Query parameter is required and must be a string.' });
  }

  // 1. Queue write update in BatchWriter buffer
  batchWriter.addQuery(query);

  // 2. Log in TrendingTracker (sliding window)
  trendingTracker.recordSearch(query);

  // 3. Proactively invalidate caches matching this query's prefixes
  await invalidateCacheForQuery(query);

  return res.json({ message: 'Searched', query });
});

// 3. GET /cache/debug?prefix=<prefix>
app.get('/cache/debug', async (req, res) => {
  const prefix = (req.query.prefix || '').trim().toLowerCase();
  try {
    const route = ring.getNode(prefix);
    const nodeCachedKeys = await route.node.keys();
    return res.json({
      prefix,
      responsibleNode: route.debug.nodeId,
      keyHash: route.debug.keyHash,
      vNodeHash: route.debug.vNodeHash,
      ringIndex: route.debug.ringIndex,
      nodeCachedKeys
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// 4. GET /metrics
app.get('/metrics', async (req, res) => {
  try {
    const cacheNodes = await ring.getAllNodeStats();
    res.json({
      latency: getLatencyMetrics(),
      database: db.getStats(),
      cacheNodes,
      batchWriter: batchWriter.getStats(),
      trendingNow: trendingTracker.getTrendingNow(10),
      ringLayout: ring.getRingLayout()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. POST /simulate
app.post('/simulate', async (req, res) => {
  const count = parseInt(req.body.count, 10) || 100;
  const isTrendingSimulation = req.body.type === 'trending';

  const keys = Array.from(db.queryMap.keys());
  if (keys.length === 0) {
    return res.status(500).json({ error: 'Database index is empty.' });
  }

  const simulatedQueries = [];
  if (isTrendingSimulation) {
    const trendingList = ['vintage clock', 'artificial keyboard', 'antigravity boots', 'deep learning study'];
    for (let i = 0; i < count; i++) {
      const q = trendingList[Math.floor(Math.random() * trendingList.length)];
      simulatedQueries.push(q);
    }
  } else {
    const selectionPool = keys.slice(0, 500);
    for (let i = 0; i < count; i++) {
      const q = selectionPool[Math.floor(Math.random() * selectionPool.length)];
      simulatedQueries.push(q);
    }
  }

  for (const q of simulatedQueries) {
    batchWriter.addQuery(q);
    trendingTracker.recordSearch(q);
    await invalidateCacheForQuery(q);
  }

  return res.json({
    status: 'Simulation running',
    count: simulatedQueries.length,
    queriesSample: simulatedQueries.slice(0, 5)
  });
});

// 6. POST /cache/flush
app.post('/cache/flush', async (req, res) => {
  try {
    for (const node of ring.nodes.values()) {
      await node.clear();
    }
    return res.json({ message: 'All logical cache nodes flushed.' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Graceful shutdown handler
async function gracefulShutdown() {
  console.log('Shutting down... Flushing batch writer...');
  batchWriter.flush();
  batchWriter.stop();
  
  try {
    await db.close();
    ring.disconnectAll();
    console.log('Connections closed successfully.');
  } catch (e) {
    console.error('Error during shutdown:', e);
  }
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Start database and Express listener
async function startServer() {
  try {
    // 1. Initialize PostgreSQL database and Trie index
    await db.initialize();
    
    // 2. Start BatchWriter flush process
    batchWriter.start();
    
    // 3. Start Express server
    app.listen(PORT, () => {
      console.log(`Server listening on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Critical failure during server startup:', error);
    process.exit(1);
  }
}

startServer();
