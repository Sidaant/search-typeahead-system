import path from 'path';
import { fileURLToPath } from 'url';
import { Database } from './db.js';
import { ConsistentHashRing } from './consistentHash.js';
import { TrendingTracker } from './trending.js';
import { BatchWriter } from './batchWriter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Simple color helper for CLI
const green = (text) => `\x1b[32m${text}\x1b[0m`;
const red = (text) => `\x1b[31m${text}\x1b[0m`;
const cyan = (text) => `\x1b[36m${text}\x1b[0m`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(red(`Assertion failed: ${message}`));
  }
  console.log(green(`  ✓ Pass: ${message}`));
}

async function runTests() {
  console.log(cyan('\n================================================'));
  console.log(cyan('RUNNING AUTOMATED TESTS FOR SEARCH TYPEAHEAD'));
  console.log(cyan('================================================\n'));

  const csvPath = path.join(__dirname, '..', 'data', 'queries.csv');
  let db;
  let ring;

  // Test 1: Database & Trie Initialization (PostgreSQL)
  console.log(cyan('Test 1: Trie & PostgreSQL Database Ingestion'));
  try {
    // Configure connection for localhost postgres port forwarded by docker
    db = new Database(csvPath);
    await db.initialize();
    
    assert(db.queryMap.size >= 100000, 'Loads more than 100,000 queries');
    assert(db.getQueryCount('iphone') > 0, 'Retrieves correct count for popular term "iphone"');
  } catch (error) {
    console.error(red('Test 1 Failed. Make sure docker compose stack is running. Error:'), error);
    process.exit(1);
  }

  // Test 2: Basic Typeahead Match & Order
  console.log(cyan('\nTest 2: Basic Suggestions prefix match and count sort'));
  const suggestIph = db.suggest('iph');
  assert(suggestIph.length > 0, 'Returns suggestions for prefix "iph"');
  assert(suggestIph.length <= 10, 'Returns at most 10 suggestions');
  
  // Verify order
  let isSorted = true;
  for (let i = 1; i < suggestIph.length; i++) {
    if (suggestIph[i].count > suggestIph[i-1].count) {
      isSorted = false;
    }
  }
  assert(isSorted, 'Suggestions sorted descending by search count');
  
  // Verify starts with prefix
  let allStartWith = true;
  for (const s of suggestIph) {
    if (!s.query.startsWith('iph')) {
      allStartWith = false;
    }
  }
  assert(allStartWith, 'All suggestions match prefix spelling');

  // Verify casing and empty inputs
  const mixedCaseSuggest = db.suggest('iPhOnE');
  assert(mixedCaseSuggest.length > 0, 'Handles mixed-case prefixes gracefully');
  
  const emptySuggest = db.suggest('');
  assert(emptySuggest.length === 10, 'Empty prefix returns top overall queries from root');

  // Test 3: Consistent Hashing Ring Routing with Redis nodes
  console.log(cyan('\nTest 3: Consistent Hashing Ring key routing & Redis Client'));
  try {
    ring = new ConsistentHashRing(32);
    // Connect to local port-forwarded Redis instances
    ring.addNode('Node_A', { host: '127.0.0.1', port: 6379 });
    ring.addNode('Node_B', { host: '127.0.0.1', port: 6380 });
    ring.addNode('Node_C', { host: '127.0.0.1', port: 6381 });
    
    const route1 = ring.getNode('iphone');
    const route2 = ring.getNode('iphone');
    
    assert(route1.debug.nodeId === route2.debug.nodeId, 'Consistent hashing routing is stable for identical keys');
    
    // Verify virtual node mapping distributes nodes
    const layout = ring.getRingLayout();
    assert(layout.length === 3 * 32, 'Ring maps 32 virtual nodes per physical node (96 total)');
    
    // Test Cache Operations
    const testNode = route1.node;
    await testNode.clear();
    
    await testNode.set('key1', [{ query: 'test_item', count: 10 }]);
    const val = await testNode.get('key1');
    assert(val !== null && val[0].query === 'test_item', 'Cache retrieves valid stored entry from Redis');
    
    // Test cache miss
    const valMiss = await testNode.get('nonexistent');
    assert(valMiss === null, 'Cache returns null on miss');
    
    // Test cache TTL
    await testNode.set('temp_key', 'temp_val', 20); // 20ms TTL
    await new Promise(resolve => setTimeout(resolve, 50));
    const valExpired = await testNode.get('temp_key');
    assert(valExpired === null, 'Cache entries expire in Redis after TTL');
    
  } catch (error) {
    console.error(red('Test 3 Failed:'), error);
    if (db) await db.close();
    if (ring) ring.disconnectAll();
    process.exit(1);
  }

  // Test 4: Batch Writes Buffer & Queue (Postgres upserts)
  console.log(cyan('\nTest 4: Batch Writes and Postgres aggregation'));
  // Set short buffer interval and max size to 3 for instant flushing
  const batchWriter = new BatchWriter(db, 100, 3);
  batchWriter.start();
  
  const testQuery = 'unique_test_query_' + Math.random().toString(36).substr(2, 5);
  const initialCount = db.getQueryCount(testQuery);
  assert(initialCount === 0, 'New query count starts at 0');
  
  batchWriter.addQuery(testQuery);
  batchWriter.addQuery(testQuery);
  
  assert(db.getQueryCount(testQuery) === 0, 'Writes are buffered and not committed immediately');
  assert(batchWriter.getStats().pendingCount === 2, 'Pending queue correctly buffers 2 queries');
  
  // Third write triggers auto-flush (max size = 3)
  batchWriter.addQuery(testQuery);
  
  // Wait a small bit for batch process & Postgres async commit
  await new Promise(resolve => setTimeout(resolve, 150));
  
  assert(db.getQueryCount(testQuery) === 3, 'Buffered counts successfully flush and update database');
  assert(batchWriter.getStats().pendingCount === 0, 'Buffer cleared after flushing');
  assert(batchWriter.getStats().savedWrites === 2, 'Accurately tracks database writes saved');
  
  batchWriter.stop();

  // Test 5: Trending Searches ranking
  console.log(cyan('\nTest 5: Trending Searches (Recency Ranking)'));
  const trendingTracker = new TrendingTracker(1000); // 1s sliding window
  
  // Record normal searches
  trendingTracker.recordSearch('rare query x');
  trendingTracker.recordSearch('rare query x');
  
  const recentCounts = trendingTracker.getRecentCounts();
  assert(recentCounts.get('rare query x') === 2, 'Sliding window records recent counts');
  
  // Wait for window decay
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert(trendingTracker.getRecentCounts().get('rare query x') === undefined, 'Recent searches expire from window after duration');
  
  // Check ranking combination
  trendingTracker.recordSearch('rare query y');
  trendingTracker.recordSearch('rare query y');
  
  const dbCandidates = [
    { query: 'popular query x', count: 1000 },
    { query: 'rare query y', count: 5 }
  ];
  
  const ranked = trendingTracker.rankSuggestions(dbCandidates, '', 5000);
  assert(ranked[0].query === 'rare query y', 'Trending query with recency weight outranks historically popular query');
  assert(ranked[0].trending === true, 'Trending badge flag is set to true');

  // Cleanup connections
  console.log(cyan('\nCleaning up database and cache connections...'));
  await db.close();
  ring.disconnectAll();

  console.log(cyan('\n================================================'));
  console.log(green('ALL TESTS COMPLETED SUCCESSFULLY!'));
  console.log(cyan('================================================\n'));
}

runTests();
