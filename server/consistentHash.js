import crypto from 'crypto';
import Redis from 'ioredis';

// Simple FNV-1a or MD5 hashing to map keys and nodes to a 32-bit integer ring
function hashString(str) {
  const hash = crypto.createHash('md5').update(str).digest();
  return hash.readUInt32BE(0); // Returns a 32-bit unsigned integer (0 to 4294967295)
}

export class CacheNode {
  constructor(nodeId, redisOptions = { host: 'localhost', port: 6379 }) {
    this.nodeId = nodeId;
    this.hits = 0;
    this.misses = 0;
    
    // Connect to real Redis container
    this.client = new Redis({
      ...redisOptions,
      retryStrategy: (times) => {
        // Try reconnecting up to 10 times with 1s gap (helps during startup race)
        if (times > 10) return null;
        return 1000;
      }
    });

    this.client.on('error', (err) => {
      // Log errors without crashing the main Node.js process
      console.error(`Redis node [${this.nodeId}] Connection Error:`, err.message);
    });
  }

  // Get cached suggestions
  async get(key) {
    try {
      const val = await this.client.get(key);
      if (!val) {
        this.misses++;
        return null;
      }
      this.hits++;
      return JSON.parse(val);
    } catch (e) {
      console.error(`Error reading from Redis node ${this.nodeId}:`, e.message);
      this.misses++;
      return null; // Fail-open fallback on Redis failure
    }
  }

  // Store suggestions in Redis with a millisecond-based TTL (PX)
  async set(key, value, ttlMs = 30000) {
    try {
      const serialized = JSON.stringify(value);
      if (ttlMs > 0) {
        await this.client.set(key, serialized, 'PX', ttlMs);
      } else {
        await this.client.set(key, serialized);
      }
    } catch (e) {
      console.error(`Error writing to Redis node ${this.nodeId}:`, e.message);
    }
  }

  // Delete matching keys for invalidation
  async delete(key) {
    try {
      await this.client.del(key);
    } catch (e) {
      console.error(`Error deleting key from Redis node ${this.nodeId}:`, e.message);
    }
  }

  // Fetch list of active keys
  async keys() {
    try {
      return await this.client.keys('*');
    } catch (e) {
      return [];
    }
  }

  // Clear node contents
  async clear() {
    try {
      await this.client.flushdb();
    } catch (e) {
      console.error(`Error flushing Redis node ${this.nodeId}:`, e.message);
    }
  }

  // Fetch performance stats
  async getStats() {
    let size = 0;
    try {
      size = await this.client.dbsize();
    } catch (e) {}
    
    return {
      nodeId: this.nodeId,
      size,
      maxSize: 'No Limit (Redis)',
      hits: this.hits,
      misses: this.misses,
      evictions: 'Managed by Redis (LRU)',
      hitRate: this.hits + this.misses === 0 ? 0 : this.hits / (this.hits + this.misses)
    };
  }

  // Disconnect client
  disconnect() {
    this.client.disconnect();
  }
}

export class ConsistentHashRing {
  constructor(virtualNodesCount = 32) {
    this.virtualNodesCount = virtualNodesCount;
    this.ring = []; // Array of { hash, nodeId } sorted by hash
    this.nodes = new Map(); // nodeId -> CacheNode
  }

  addNode(nodeId, redisOptions = { host: 'localhost', port: 6379 }) {
    if (this.nodes.has(nodeId)) return;

    const node = new CacheNode(nodeId, redisOptions);
    this.nodes.set(nodeId, node);

    // Add virtual nodes to the ring
    for (let i = 0; i < this.virtualNodesCount; i++) {
      const vNodeKey = `${nodeId}-vnode-${i}`;
      const hash = hashString(vNodeKey);
      this.ring.push({ hash, nodeId });
    }

    // Sort ring by hash ascending
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  removeNode(nodeId) {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    node.disconnect();
    this.nodes.delete(nodeId);
    
    // Remove virtual nodes from the ring
    this.ring = this.ring.filter(vNode => vNode.nodeId !== nodeId);
  }

  // Route a prefix key to the responsible CacheNode
  getNode(key) {
    if (this.ring.length === 0) {
      throw new Error('No cache nodes available in the hash ring.');
    }

    const keyHash = hashString(key);
    
    // Binary search for the first virtual node with hash >= keyHash
    let low = 0;
    let high = this.ring.length - 1;
    let index = 0; // default wrap-around to index 0

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (this.ring[mid].hash >= keyHash) {
        index = mid;
        high = mid - 1; // Try to find a smaller hash that is still >= keyHash
      } else {
        low = mid + 1;
      }
    }

    const targetNodeId = this.ring[index].nodeId;
    const responsibleNode = this.nodes.get(targetNodeId);

    return {
      node: responsibleNode,
      debug: {
        key,
        keyHash,
        vNodeHash: this.ring[index].hash,
        nodeId: targetNodeId,
        ringIndex: index
      }
    };
  }

  // Get statistics for all nodes in the ring
  async getAllNodeStats() {
    const stats = [];
    for (const node of this.nodes.values()) {
      stats.push(await node.getStats());
    }
    return stats;
  }

  // Get list of all nodes and their ring hash mappings (for UI visualization)
  getRingLayout() {
    return this.ring.map(v => ({
      hash: v.hash,
      nodeId: v.nodeId,
      angle: (v.hash / 4294967295) * 2 * Math.PI // Map hash space to 0-360 degrees (in radians)
    }));
  }

  // Disconnect all node connections
  disconnectAll() {
    for (const node of this.nodes.values()) {
      node.disconnect();
    }
  }
}
