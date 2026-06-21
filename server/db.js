import fs from 'fs';
import path from 'path';
import pg from 'pg';

const { Pool } = pg;

class TrieNode {
  constructor() {
    this.children = {};
    this.isWord = false;
    // Cache of top 10 suggestions passing through this node.
    // Each suggestion is { query: string, count: number }
    this.topSuggestions = [];
  }
}

export class Database {
  constructor(csvPath) {
    this.csvPath = csvPath;
    this.queryMap = new Map(); // query string -> count
    this.root = new TrieNode();
    this.readOpsCount = 0;
    this.writeOpsCount = 0;
    this.isSaving = false;
    this.savePending = false;
    
    // PostgreSQL Pool configuration
    const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/typeahead';
    this.pool = new Pool({ connectionString });
  }

  // Asynchronous initialization (connects to DB, creates tables, seeds, and loads into memory)
  async initialize() {
    console.log('Connecting to PostgreSQL database...');
    
    // Test database connection
    try {
      const client = await this.pool.connect();
      client.release();
      console.log('PostgreSQL connection established successfully.');
    } catch (err) {
      console.error('Failed to connect to PostgreSQL. Retrying in 2 seconds...', err);
      // Wait and retry once for Docker container startups
      await new Promise(resolve => setTimeout(resolve, 2000));
      const client = await this.pool.connect();
      client.release();
      console.log('PostgreSQL connection established successfully on retry.');
    }

    // 1. Create table if not exists
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS search_queries (
        query VARCHAR(255) PRIMARY KEY,
        count INT NOT NULL DEFAULT 1,
        last_searched TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_search_queries_count ON search_queries (count DESC);
    `);

    // 2. Check if table is empty
    const { rows } = await this.pool.query('SELECT COUNT(*) FROM search_queries');
    const dbCount = parseInt(rows[0].count, 10);
    
    if (dbCount === 0) {
      // Seed table from CSV file
      console.log('PostgreSQL database is empty. Seeding from CSV...');
      await this.seedFromCSV();
    } else {
      console.log(`Database already seeded. Found ${dbCount} records.`);
    }

    // 3. Load database contents into Trie index
    await this.loadFromPostgres();
  }

  // Load CSV dataset and seed PostgreSQL database using bulk insert
  async seedFromCSV() {
    const start = performance.now();
    
    if (!fs.existsSync(this.csvPath)) {
      throw new Error(`Seed dataset file not found at ${this.csvPath}. Please run seed script first.`);
    }

    const fileContent = fs.readFileSync(this.csvPath, 'utf8');
    const lines = fileContent.split(/\r?\n/);
    
    console.log(`Reading CSV contents. Parsing ${lines.length - 1} entries...`);
    const batch = [];
    const batchSize = 5000;
    
    // Skip header line
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      const commaIdx = line.lastIndexOf(',');
      if (commaIdx === -1) continue;
      
      const query = line.substring(0, commaIdx);
      const count = parseInt(line.substring(commaIdx + 1), 10);
      
      if (query && !isNaN(count)) {
        batch.push({ query, count });
      }

      // Flush batch when size limit reached
      if (batch.length >= batchSize || i === lines.length - 1) {
        await this.insertSQLBatch(batch);
        batch.length = 0; // Clear array
      }
    }
    
    const end = performance.now();
    console.log(`Successfully seeded PostgreSQL in ${((end - start) / 1000).toFixed(2)} seconds.`);
  }

  // Bulk SQL insert helper
  async insertSQLBatch(batch) {
    if (batch.length === 0) return;
    
    // Construct multi-row INSERT query:
    // INSERT INTO search_queries (query, count) VALUES ($1, $2), ($3, $4), ...
    const valuePlaceholders = [];
    const flatValues = [];
    
    for (let i = 0; i < batch.length; i++) {
      const pIdx = i * 2;
      valuePlaceholders.push(`($${pIdx + 1}, $${pIdx + 2}, NOW())`);
      flatValues.push(batch[i].query, batch[i].count);
    }
    
    const sql = `
      INSERT INTO search_queries (query, count, last_searched)
      VALUES ${valuePlaceholders.join(', ')}
      ON CONFLICT (query) DO UPDATE
      SET count = search_queries.count + EXCLUDED.count, last_searched = NOW();
    `;
    
    await this.pool.query(sql, flatValues);
  }

  // Fetch all queries from Postgres and populate the in-memory Trie
  async loadFromPostgres() {
    const start = performance.now();
    console.log('Loading database records from PostgreSQL into Trie...');
    
    const { rows } = await this.pool.query('SELECT query, count FROM search_queries');
    
    for (const row of rows) {
      this.queryMap.set(row.query, row.count);
      this.insertIntoTrie(row.query, row.count);
    }
    
    const end = performance.now();
    console.log(`Trie index loaded with ${this.queryMap.size} records in ${(end - start).toFixed(2)}ms`);
  }

  // Insert/Update helper for Trie
  insertIntoTrie(query, count) {
    let node = this.root;
    const entry = { query, count };
    
    this.updateSuggestionsList(node.topSuggestions, entry);

    for (const char of query) {
      if (!node.children[char]) {
        node.children[char] = new TrieNode();
      }
      node = node.children[char];
      this.updateSuggestionsList(node.topSuggestions, entry);
    }
    node.isWord = true;
  }

  // Update sorted list of suggestions inside a TrieNode
  updateSuggestionsList(list, entry) {
    const existingIdx = list.findIndex(item => item.query === entry.query);
    
    if (existingIdx !== -1) {
      list[existingIdx].count = entry.count;
    } else {
      list.push({ ...entry });
    }
    
    list.sort((a, b) => b.count - a.count || a.query.localeCompare(b.query));
    
    if (list.length > 10) {
      list.pop();
    }
  }

  // Basic suggestions prefix lookup
  suggest(prefix) {
    this.readOpsCount++;
    const cleanPrefix = (prefix || '').trim().toLowerCase();
    
    if (!cleanPrefix) {
      return this.root.topSuggestions;
    }

    let node = this.root;
    for (const char of cleanPrefix) {
      if (!node.children[char]) {
        return [];
      }
      node = node.children[char];
    }
    
    return node.topSuggestions;
  }

  // DFS search to collect candidates for trending re-ranking
  getPrefixMatches(prefix, limit = 200) {
    this.readOpsCount++;
    const cleanPrefix = (prefix || '').trim().toLowerCase();
    
    let node = this.root;
    if (cleanPrefix) {
      for (const char of cleanPrefix) {
        if (!node.children[char]) {
          return [];
        }
        node = node.children[char];
      }
    }
    
    const results = [];
    this.dfsCollect(node, cleanPrefix, results, limit);
    return results;
  }

  dfsCollect(node, currentWord, results, limit) {
    if (results.length >= limit) return;
    
    if (node.isWord) {
      const count = this.queryMap.get(currentWord) || 0;
      results.push({ query: currentWord, count });
    }
    
    const childrenKeys = Object.keys(node.children);
    for (const char of childrenKeys) {
      this.dfsCollect(node.children[char], currentWord + char, results, limit);
      if (results.length >= limit) break;
    }
  }

  // Commit batch updates to PostgreSQL and update Trie
  async batchUpdate(updates) {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      for (const [query, increment] of updates) {
        const cleanQuery = query.trim().toLowerCase();
        if (!cleanQuery) continue;
        
        this.writeOpsCount++;
        
        // Update in-memory Map
        const currentCount = this.queryMap.get(cleanQuery) || 0;
        const newCount = currentCount + increment;
        this.queryMap.set(cleanQuery, newCount);
        
        // Update in-memory Trie
        this.insertIntoTrie(cleanQuery, newCount);
        
        // Upsert to PostgreSQL
        await client.query(`
          INSERT INTO search_queries (query, count, last_searched)
          VALUES ($1, $2, NOW())
          ON CONFLICT (query) DO UPDATE
          SET count = search_queries.count + EXCLUDED.count, last_searched = NOW()
        `, [cleanQuery, increment]);
      }
      
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('Failed to commit PostgreSQL batch transaction:', e);
    } finally {
      client.release();
    }
    
    // Save to CSV in background as a local backup
    this.saveToCSV();
  }

  // Save state back to CSV in background
  saveToCSV() {
    if (this.isSaving) {
      this.savePending = true;
      return;
    }
    this.isSaving = true;
    this.savePending = false;

    try {
      const csvLines = ['query,count'];
      const sortedQueries = [...this.queryMap.entries()].sort((a, b) => b[1] - a[1]);
      
      for (const [query, count] of sortedQueries) {
        csvLines.push(`${query},${count}`);
      }
      
      fs.writeFile(this.csvPath, csvLines.join('\n'), 'utf8', (err) => {
        this.isSaving = false;
        if (err) {
          console.error('Error saving CSV to disk:', err);
        }
        if (this.savePending) {
          this.saveToCSV();
        }
      });
    } catch (e) {
      this.isSaving = false;
      console.error('Failed to trigger CSV backup write:', e);
    }
  }

  // Check query count
  getQueryCount(query) {
    this.readOpsCount++;
    return this.queryMap.get(query.trim().toLowerCase()) || 0;
  }

  // Return statistics
  getStats() {
    return {
      totalQueries: this.queryMap.size,
      readOps: this.readOpsCount,
      writeOps: this.writeOpsCount
    };
  }

  // Close connection pool
  async close() {
    await this.pool.end();
  }
}
